/**
 * Batch transcription of an audio file, reusing the exact same STT provider
 * sessions as live listening (SttService + factory.createSTT). The file is
 * decoded to PCM16 mono with ffmpeg and streamed through the provider at an
 * accelerated pace.
 */
const fs = require('fs');
const { spawn } = require('child_process');
const SttService = require('../features/listen/stt/sttService');

const CHUNK_DURATION_S = 0.1;
const BYTES_PER_SAMPLE = 2;
// Feed faster than realtime; cloud realtime endpoints tolerate this well.
const PACING_FACTOR = 8;
// Consider transcription finished when no new final arrives for this long
// (must exceed SttService's 2 s completion debounce).
const SETTLE_MS = 3500;
const MAX_SETTLE_WAIT_MS = 60_000;

function decodeToPcm(ffmpegPath, filePath, sampleRate) {
    return new Promise((resolve, reject) => {
        const proc = spawn(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error',
            '-i', filePath,
            '-ac', '1',
            '-ar', String(sampleRate),
            '-f', 's16le',
            '-',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        const chunks = [];
        let stderr = '';
        proc.stdout.on('data', d => chunks.push(d));
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('error', err => reject(new Error(
            err.code === 'ENOENT'
                ? `ffmpeg not found at "${ffmpegPath}". Install ffmpeg or set GLASS_FFMPEG_PATH.`
                : err.message
        )));
        proc.on('close', code => {
            if (code === 0) resolve(Buffer.concat(chunks));
            else reject(new Error(`ffmpeg failed to decode "${filePath}": ${stderr.trim()}`));
        });
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {object} config  built by config.js
 * @param {string} filePath
 * @param {string} [language]
 * @returns {Promise<{text: string, segments: string[], duration_s: number}>}
 */
async function transcribeFile(config, filePath, language) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Audio file not found: ${filePath}`);
    }

    const { stt, ffmpegPath } = config;
    const pcm = await decodeToPcm(ffmpegPath, filePath, stt.sampleRate);
    if (pcm.length === 0) {
        throw new Error('Decoded audio is empty.');
    }
    const durationS = pcm.length / (stt.sampleRate * BYTES_PER_SAMPLE);

    const segments = [];
    let lastFinalAt = Date.now();

    const sttService = new SttService();
    // Batch transcription must not leak stt-update events into the listen UI.
    sttService.sendToRenderer = () => {};
    sttService.setCallbacks({
        onTranscriptionComplete: (_speaker, text) => {
            segments.push(text);
            lastFinalAt = Date.now();
        },
        onStatusUpdate: () => {},
    });

    try {
        await sttService.initializeSttSessions(language || stt.language, {
            provider: stt.provider,
            model: stt.model,
            apiKey: stt.apiKey,
            // Audio is ffmpeg-decoded to stt.sampleRate above; hand that real
            // rate to the whisper WAV header (overrides the live 24 kHz default).
            sampleRate: stt.sampleRate,
        });

        const chunkSize = stt.sampleRate * BYTES_PER_SAMPLE * CHUNK_DURATION_S;
        for (let offset = 0; offset < pcm.length; offset += chunkSize) {
            const chunk = pcm.subarray(offset, offset + chunkSize);
            await sttService.sendMicAudioContent(chunk.toString('base64'));
            await sleep((CHUNK_DURATION_S * 1000) / PACING_FACTOR);
        }

        // Wait for the provider + completion debounce to settle.
        lastFinalAt = Date.now();
        const settleStart = Date.now();
        while (Date.now() - lastFinalAt < SETTLE_MS) {
            if (Date.now() - settleStart > MAX_SETTLE_WAIT_MS) break;
            await sleep(250);
        }
    } finally {
        await sttService.closeSessions().catch(() => {});
    }

    return {
        text: segments.join(' '),
        segments,
        duration_s: Math.round(durationS * 10) / 10,
    };
}

module.exports = { transcribeFile };
