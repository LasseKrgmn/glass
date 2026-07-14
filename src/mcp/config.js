/**
 * MCP-mode configuration for Glass.
 *
 * When the app is started as an MCP server (electron . --mcp), everything the
 * setup wizard / settings UI used to configure comes from environment
 * variables in the MCP client config instead. Only transcription (STT) has a
 * selectable provider/model here — the LLM side is always the MCP client
 * model (the LLM that is connected to this server).
 */
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

function isMcpMode(argv = process.argv, env = process.env) {
    return argv.includes('--mcp') || env.GLASS_MCP === '1';
}

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
    // are fed 24 kHz PCM16 mono (only relevant for the transcribe_audio tool —
    // live capture keeps the renderer pipeline of the Electron app).
    const sampleRate = provider === 'whisper' ? 16000 : 24000;

    return {
        stt: {
            provider,
            model,
            apiKey,
            language: env.GLASS_LANGUAGE || 'en',
            sampleRate,
        },
        llm: {
            // Seconds to wait for the MCP client model to answer an app-internal
            // request (Ask / live summary) before failing that request.
            timeoutS: parseInt(env.GLASS_LLM_TIMEOUT_S || '300', 10),
        },
        screenshot: {
            height: parseInt(env.GLASS_SCREENSHOT_HEIGHT || '384', 10),
            quality: parseInt(env.GLASS_SCREENSHOT_QUALITY || '80', 10),
        },
        ffmpegPath: env.GLASS_FFMPEG_PATH || 'ffmpeg', // only needed for transcribe_audio
    };
}

module.exports = { buildConfig, isMcpMode, DEFAULT_STT_MODELS };
