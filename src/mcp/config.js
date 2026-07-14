/**
 * MCP server configuration.
 *
 * Everything is driven by environment variables set in the MCP client config
 * (e.g. claude_desktop_config.json / .mcp.json) — there is no setup or
 * settings UI. Transcription keeps the existing Glass provider methods and
 * model selection; the provider/model is chosen here once at startup.
 */
const os = require('os');
const path = require('path');
const { PROVIDERS } = require('../features/common/ai/factory');

const DEFAULT_STT_MODELS = {
    openai: 'gpt-4o-mini-transcribe',
    gemini: 'gemini-live-2.5-flash-preview',
    deepgram: 'nova-3',
    whisper: 'whisper-base',
};

const API_KEY_ENV = {
    openai: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
    deepgram: 'DEEPGRAM_API_KEY',
};

function buildConfig(env = process.env) {
    const provider = (env.GLASS_STT_PROVIDER || 'whisper').toLowerCase();

    const providerDef = PROVIDERS[provider];
    if (!providerDef || providerDef.sttModels.length === 0) {
        const supported = Object.entries(PROVIDERS)
            .filter(([, p]) => p.sttModels.length > 0)
            .map(([id]) => id)
            .join(', ');
        throw new Error(`GLASS_STT_PROVIDER="${provider}" does not support STT. Supported providers: ${supported}`);
    }

    const model = env.GLASS_STT_MODEL || DEFAULT_STT_MODELS[provider] || providerDef.sttModels[0].id;

    let apiKey;
    if (provider === 'whisper') {
        apiKey = 'local'; // Local whisper.cpp needs no key.
    } else {
        const keyEnv = API_KEY_ENV[provider];
        apiKey = env.GLASS_STT_API_KEY || (keyEnv ? env[keyEnv] : undefined);
        if (!apiKey) {
            throw new Error(
                `Missing API key for STT provider "${provider}". ` +
                `Set ${keyEnv || 'GLASS_STT_API_KEY'}${keyEnv ? ' (or GLASS_STT_API_KEY)' : ''} in the MCP server env config.`
            );
        }
    }

    // Whisper.cpp consumes 16 kHz PCM16 mono; the realtime cloud providers
    // (OpenAI / Gemini / Deepgram) are fed 24 kHz PCM16 mono, matching what
    // the Electron renderer capture pipeline sends.
    const sampleRate = provider === 'whisper' ? 16000 : 24000;

    const capture = (env.GLASS_CAPTURE || (process.platform === 'darwin' ? 'both' : 'mic')).toLowerCase();
    if (!['mic', 'system', 'both', 'none'].includes(capture)) {
        throw new Error(`GLASS_CAPTURE must be one of mic|system|both|none, got "${capture}"`);
    }

    return {
        stt: {
            provider,
            model,
            apiKey,
            language: env.GLASS_LANGUAGE || 'en',
            sampleRate,
        },
        capture: {
            mode: capture,                       // mic | system | both | none
            micDevice: env.GLASS_MIC_DEVICE || null, // ffmpeg input device name/index
            ffmpegPath: env.GLASS_FFMPEG_PATH || 'ffmpeg',
        },
        screenshot: {
            height: parseInt(env.GLASS_SCREENSHOT_HEIGHT || '384', 10),
            quality: parseInt(env.GLASS_SCREENSHOT_QUALITY || '80', 10),
        },
        dataDir: env.GLASS_DATA_DIR || path.join(os.homedir(), '.glass', 'mcp'),
    };
}

module.exports = { buildConfig, DEFAULT_STT_MODELS };
