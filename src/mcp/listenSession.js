/**
 * Headless "Listen" feature for the MCP server.
 *
 * Orchestrates the existing SttService (unchanged transcription methods and
 * provider/model selection) with headless audio capture and file-based
 * storage. Summaries are NOT generated here — the client LLM reads the
 * transcript via get_transcript (cursor-based, deltas only) and writes its
 * own analysis back via save_summary, which keeps token usage minimal.
 */
const SttService = require('../features/listen/stt/sttService');
const { MicCapture } = require('./audioCapture');

class ListenSessionManager {
    constructor(config, storage) {
        this.config = config;
        this.storage = storage;
        this.sttService = null;
        this.micCapture = null;
        this.session = null;          // storage session record
        this.captureErrors = [];
        this.systemAudioActive = false;
    }

    isActive() {
        return !!this.session;
    }

    /**
     * @param {object} opts
     * @param {string} [opts.language]  overrides GLASS_LANGUAGE for this session
     * @param {string} [opts.title]
     */
    async start({ language, title } = {}) {
        if (this.session) {
            throw new Error(`A listen session is already active (id: ${this.session.id}). Stop it first.`);
        }

        const { stt, capture } = this.config;
        const effectiveLanguage = language || stt.language;

        const session = this.storage.createSession('listen', title);
        this.captureErrors = [];
        this.systemAudioActive = false;

        this.sttService = new SttService();
        this.sttService.setCallbacks({
            onTranscriptionComplete: (speaker, text) => {
                if (this.session) {
                    this.storage.addTranscript(this.session.id, { speaker, text });
                }
            },
            onStatusUpdate: () => {},
        });

        try {
            await this.sttService.initializeSttSessions(effectiveLanguage, {
                provider: stt.provider,
                model: stt.model,
                apiKey: stt.apiKey,
            });
        } catch (err) {
            this.storage.deleteSession(session.id);
            this.sttService = null;
            throw err;
        }

        this.session = session;

        // ── Audio sources ────────────────────────────────────────────────
        const active = [];

        if (capture.mode === 'system' || capture.mode === 'both') {
            if (process.platform === 'darwin') {
                const ok = await this.sttService.startMacOSAudioCapture();
                if (ok) {
                    this.systemAudioActive = true;
                    active.push('system (SystemAudioDump)');
                } else {
                    this.captureErrors.push('system: SystemAudioDump failed to start');
                }
            } else {
                this.captureErrors.push('system: only available on macOS');
            }
        }

        if (capture.mode === 'mic' || capture.mode === 'both') {
            try {
                this.micCapture = new MicCapture({
                    ffmpegPath: capture.ffmpegPath,
                    micDevice: capture.micDevice,
                    sampleRate: stt.sampleRate,
                    onChunk: base64 => {
                        this.sttService?.sendMicAudioContent(base64).catch(err => {
                            this.captureErrors.push(`mic->stt: ${err.message}`);
                        });
                    },
                    onError: err => {
                        this.captureErrors.push(err.message);
                        this.micCapture = null;
                    },
                });
                this.micCapture.start();
                active.push(`mic (ffmpeg, ${stt.sampleRate} Hz)`);
            } catch (err) {
                this.micCapture = null;
                this.captureErrors.push(`mic: ${err.message}`);
            }
        }

        if (capture.mode !== 'none' && active.length === 0) {
            // Nothing is producing audio — fail loudly instead of listening to silence.
            await this.stop().catch(() => {});
            throw new Error(`No audio source could be started: ${this.captureErrors.join('; ')}`);
        }

        return {
            session_id: session.id,
            stt: { provider: stt.provider, model: stt.model, language: effectiveLanguage },
            audio_sources: active,
            warnings: this.captureErrors.length ? this.captureErrors : undefined,
        };
    }

    status() {
        if (!this.session) {
            return { active: false };
        }
        return {
            active: true,
            session_id: this.session.id,
            started_at: this.session.started_at,
            duration_s: Math.round((Date.now() - this.session.started_at) / 1000),
            transcript_lines: this.storage.countTranscripts(this.session.id),
            audio_sources: {
                mic: !!this.micCapture?.isRunning(),
                system: this.systemAudioActive,
            },
            warnings: this.captureErrors.length ? this.captureErrors : undefined,
        };
    }

    async stop() {
        if (!this.session) {
            throw new Error('No active listen session.');
        }
        const sessionId = this.session.id;

        if (this.micCapture) {
            this.micCapture.stop();
            this.micCapture = null;
        }
        if (this.sttService) {
            try {
                await this.sttService.closeSessions(); // also stops SystemAudioDump
            } catch (err) {
                console.error('[ListenSessionManager] Error closing STT sessions:', err.message);
            }
            this.sttService = null;
        }
        this.systemAudioActive = false;

        this.storage.endSession(sessionId);
        const session = this.storage.getSession(sessionId);
        this.session = null;

        return {
            session_id: sessionId,
            duration_s: Math.round((session.ended_at - session.started_at) / 1000),
            transcript_lines: this.storage.countTranscripts(sessionId),
        };
    }

    /** Session id of the active session, or null. */
    activeSessionId() {
        return this.session?.id || null;
    }
}

module.exports = ListenSessionManager;
