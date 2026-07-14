let spawn, path, EventEmitter, os;

if (typeof window === 'undefined') {
    spawn = require('child_process').spawn;
    path = require('path');
    EventEmitter = require('events').EventEmitter;
    os = require('os');
} else {
    class DummyEventEmitter {
        on() {}
        emit() {}
        removeAllListeners() {}
    }
    EventEmitter = DummyEventEmitter;
}

// whisper.cpp performance tuning. Defaults favour realtime latency and are
// hardware-aware (thread count capped to the available CPUs); every value can
// be overridden through the environment so the MCP client config / headless
// callers can adapt them without code changes.
//   GLASS_WHISPER_THREADS   – CPU threads for the decoder (default: min(8, #cpus))
//   GLASS_WHISPER_BEAM_SIZE – beam size / best-of (default: 1 → greedy, fastest)
// The encoder runs on the GPU (Metal on Apple Silicon) with flash-attention,
// which whisper-cli enables by default, so these mostly govern the decoder.
const _env = (typeof process !== 'undefined' && process.env) ? process.env : {};
const DEFAULT_WHISPER_THREADS = Math.max(
    1,
    parseInt(_env.GLASS_WHISPER_THREADS, 10) || Math.min(8, (os?.cpus?.().length || 4))
);
const DEFAULT_WHISPER_BEAM_SIZE = Math.max(1, parseInt(_env.GLASS_WHISPER_BEAM_SIZE, 10) || 1);

class WhisperSTTSession extends EventEmitter {
    constructor(model, whisperService, sessionId, options = {}) {
        super();
        this.model = model;
        this.whisperService = whisperService;
        this.sessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        // Force the spoken language when the caller provides one (e.g. 'de');
        // 'auto' keeps whisper's per-chunk language detection. Pinning the
        // language is both faster (no detection pass) and more accurate on the
        // short realtime chunks than auto-detect.
        this.language = options.language || 'auto';
        this.threads = options.threads || DEFAULT_WHISPER_THREADS;
        this.beamSize = options.beamSize || DEFAULT_WHISPER_BEAM_SIZE;
        this.process = null;
        this.isRunning = false;
        this.audioBuffer = Buffer.alloc(0);
        this.processingInterval = null;
        this.lastTranscription = '';
    }

    async initialize() {
        try {
            await this.whisperService.ensureModelAvailable(this.model);
            this.isRunning = true;
            this.startProcessingLoop();
            return true;
        } catch (error) {
            console.error('[WhisperSTT] Initialization error:', error);
            this.emit('error', error);
            return false;
        }
    }

    startProcessingLoop() {
        this.processingInterval = setInterval(async () => {
            const minBufferSize = 16000 * 2 * 0.15;
            if (this.audioBuffer.length >= minBufferSize && !this.process) {
                console.log(`[WhisperSTT-${this.sessionId}] Processing audio chunk, buffer size: ${this.audioBuffer.length}`);
                await this.processAudioChunk();
            }
        }, 1500);
    }

    async processAudioChunk() {
        if (!this.isRunning || this.audioBuffer.length === 0) return;

        const audioData = this.audioBuffer;
        this.audioBuffer = Buffer.alloc(0);

        try {
            const tempFile = await this.whisperService.saveAudioToTemp(audioData, this.sessionId);
            
            if (!tempFile || typeof tempFile !== 'string') {
                console.error('[WhisperSTT] Invalid temp file path:', tempFile);
                return;
            }
            
            const whisperPath = await this.whisperService.getWhisperPath();
            const modelPath = await this.whisperService.getModelPath(this.model);

            if (!whisperPath || !modelPath) {
                console.error('[WhisperSTT] Invalid whisper or model path:', { whisperPath, modelPath });
                return;
            }

            this.process = spawn(whisperPath, [
                '-m', modelPath,
                '-f', tempFile,
                '--no-timestamps',
                '--output-txt',
                '--output-json',
                '--language', this.language,
                '--threads', String(this.threads),
                '--beam-size', String(this.beamSize),
                '--best-of', String(this.beamSize),
                '--print-progress', 'false'
            ]);

            let output = '';
            let errorOutput = '';

            this.process.stdout.on('data', (data) => {
                output += data.toString();
            });

            this.process.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            this.process.on('close', async (code) => {
                this.process = null;
                
                if (code === 0 && output.trim()) {
                    const transcription = output.trim();
                    if (transcription && transcription !== this.lastTranscription) {
                        this.lastTranscription = transcription;
                        console.log(`[WhisperSTT-${this.sessionId}] Transcription: "${transcription}"`);
                        this.emit('transcription', {
                            text: transcription,
                            timestamp: Date.now(),
                            confidence: 1.0,
                            sessionId: this.sessionId
                        });
                    }
                } else if (errorOutput) {
                    console.error(`[WhisperSTT-${this.sessionId}] Process error:`, errorOutput);
                }

                await this.whisperService.cleanupTempFile(tempFile);
            });

        } catch (error) {
            console.error('[WhisperSTT] Processing error:', error);
            this.emit('error', error);
        }
    }

    sendRealtimeInput(audioData) {
        if (!this.isRunning) {
            console.warn(`[WhisperSTT-${this.sessionId}] Session not running, cannot accept audio`);
            return;
        }

        if (typeof audioData === 'string') {
            try {
                audioData = Buffer.from(audioData, 'base64');
            } catch (error) {
                console.error('[WhisperSTT] Failed to decode base64 audio data:', error);
                return;
            }
        } else if (audioData instanceof ArrayBuffer) {
            audioData = Buffer.from(audioData);
        } else if (!Buffer.isBuffer(audioData) && !(audioData instanceof Uint8Array)) {
            console.error('[WhisperSTT] Invalid audio data type:', typeof audioData);
            return;
        }

        if (!Buffer.isBuffer(audioData)) {
            audioData = Buffer.from(audioData);
        }

        if (audioData.length > 0) {
            this.audioBuffer = Buffer.concat([this.audioBuffer, audioData]);
            // Log every 10th audio chunk to avoid spam
            if (Math.random() < 0.1) {
                console.log(`[WhisperSTT-${this.sessionId}] Received audio chunk: ${audioData.length} bytes, total buffer: ${this.audioBuffer.length} bytes`);
            }
        }
    }

    async close() {
        console.log(`[WhisperSTT-${this.sessionId}] Closing session`);
        this.isRunning = false;

        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }

        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }

        this.removeAllListeners();
    }
}

class WhisperProvider {
    static async validateApiKey() {
        // Whisper is a local service, no API key validation needed.
        return { success: true };
    }

    constructor() {
        this.whisperService = null;
    }

    async initialize() {
        if (!this.whisperService) {
            this.whisperService = require('../../services/whisperService');
            if (!this.whisperService.isInitialized) {
                await this.whisperService.initialize();
            }
        }
    }

    async createSTT(config) {
        await this.initialize();
        
        const model = config.model || 'whisper-tiny';
        const sessionType = config.sessionType || 'unknown';
        console.log(`[WhisperProvider] Creating ${sessionType} STT session with model: ${model}`);
        
        // Create unique session ID based on type
        const sessionId = `${sessionType}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        // Pin the spoken language when the caller specified one (GLASS_LANGUAGE
        // in the MCP config flows here as config.language). whisper wants a bare
        // code like 'de'; strip any region suffix such as 'de-DE'.
        const language = config.language ? String(config.language).split('-')[0].toLowerCase() : 'auto';
        const session = new WhisperSTTSession(model, this.whisperService, sessionId, { language });
        
        // Log session creation
        console.log(`[WhisperProvider] Created session: ${sessionId}`);
        
        const initialized = await session.initialize();
        if (!initialized) {
            throw new Error('Failed to initialize Whisper STT session');
        }

        if (config.callbacks) {
            if (config.callbacks.onmessage) {
                session.on('transcription', config.callbacks.onmessage);
            }
            if (config.callbacks.onerror) {
                session.on('error', config.callbacks.onerror);
            }
            if (config.callbacks.onclose) {
                session.on('close', config.callbacks.onclose);
            }
        }

        return session;
    }

    async createLLM() {
        throw new Error('Whisper provider does not support LLM functionality');
    }

    async createStreamingLLM() {
        console.warn('[WhisperProvider] Streaming LLM is not supported by Whisper.');
        throw new Error('Whisper does not support LLM.');
    }
}

module.exports = {
    WhisperProvider,
    WhisperSTTSession
};