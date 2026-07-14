/**
 * Headless microphone capture via ffmpeg.
 *
 * Replaces the Electron renderer's getUserMedia pipeline: raw PCM16 mono is
 * read from the default (or configured) input device and delivered as base64
 * chunks of ~100 ms — the same cadence and format the renderer sends to
 * SttService.sendMicAudioContent().
 *
 * System audio ("Them") capture continues to use the existing
 * SystemAudioDump method in SttService.startMacOSAudioCapture() on macOS.
 */
const { spawn } = require('child_process');

const CHUNK_DURATION_S = 0.1;
const BYTES_PER_SAMPLE = 2;

function micInputArgs(micDevice) {
    switch (process.platform) {
        case 'darwin':
            // avfoundation ":<index>" captures audio only; default device 0.
            return ['-f', 'avfoundation', '-i', `:${micDevice ?? '0'}`];
        case 'linux':
            return ['-f', 'pulse', '-i', micDevice ?? 'default'];
        case 'win32':
            if (!micDevice) {
                throw new Error(
                    'On Windows set GLASS_MIC_DEVICE to a dshow device name ' +
                    '(list with: ffmpeg -list_devices true -f dshow -i dummy)'
                );
            }
            return ['-f', 'dshow', '-i', `audio=${micDevice}`];
        default:
            throw new Error(`Unsupported platform for mic capture: ${process.platform}`);
    }
}

class MicCapture {
    /**
     * @param {object} opts
     * @param {string} opts.ffmpegPath
     * @param {string|null} opts.micDevice
     * @param {number} opts.sampleRate  16000 for local whisper, 24000 for cloud STT
     * @param {(base64Chunk: string) => void} opts.onChunk
     * @param {(err: Error) => void} [opts.onError]
     */
    constructor({ ffmpegPath, micDevice, sampleRate, onChunk, onError }) {
        this.ffmpegPath = ffmpegPath;
        this.micDevice = micDevice;
        this.sampleRate = sampleRate;
        this.onChunk = onChunk;
        this.onError = onError || (() => {});
        this.proc = null;
        this.stderrTail = '';
    }

    start() {
        const args = [
            '-hide_banner', '-loglevel', 'error',
            ...micInputArgs(this.micDevice),
            '-ac', '1',
            '-ar', String(this.sampleRate),
            '-f', 's16le',
            '-',
        ];

        this.proc = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

        const chunkSize = this.sampleRate * BYTES_PER_SAMPLE * CHUNK_DURATION_S;
        let buffer = Buffer.alloc(0);

        this.proc.stdout.on('data', data => {
            buffer = Buffer.concat([buffer, data]);
            while (buffer.length >= chunkSize) {
                const chunk = buffer.subarray(0, chunkSize);
                buffer = buffer.subarray(chunkSize);
                this.onChunk(chunk.toString('base64'));
            }
        });

        this.proc.stderr.on('data', data => {
            this.stderrTail = (this.stderrTail + data.toString()).slice(-2000);
        });

        this.proc.on('error', err => {
            const hint = err.code === 'ENOENT'
                ? `ffmpeg not found at "${this.ffmpegPath}". Install ffmpeg or set GLASS_FFMPEG_PATH.`
                : err.message;
            this.proc = null;
            this.onError(new Error(`Mic capture failed: ${hint}`));
        });

        this.proc.on('close', code => {
            if (this.proc && code !== 0) {
                this.onError(new Error(`ffmpeg mic capture exited with code ${code}: ${this.stderrTail.trim()}`));
            }
            this.proc = null;
        });

        return true;
    }

    isRunning() {
        return !!this.proc;
    }

    stop() {
        if (this.proc) {
            const proc = this.proc;
            this.proc = null; // prevent the close handler from reporting an error
            proc.kill('SIGTERM');
        }
    }
}

module.exports = { MicCapture };
