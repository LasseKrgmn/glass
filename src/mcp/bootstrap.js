/**
 * MCP-mode bootstrap for the Glass Electron app.
 *
 * Started with `electron . --mcp` (or GLASS_MCP=1), the full app runs exactly
 * like the normal Electron variant — all windows, the teleprompter, listen &
 * ask features — but:
 *
 *  - the setup wizard / API-key UI never appears: the model state is seeded
 *    from environment variables of the MCP client config on every start,
 *  - transcription (STT) uses the provider/model from GLASS_STT_PROVIDER /
 *    GLASS_STT_MODEL (API providers or local Whisper),
 *  - LLM requests (Ask, live summary) are answered by the MCP client model
 *    through the llmBridge instead of a vendor API,
 *  - an MCP server on stdio exposes the app's features as tools.
 */
const { buildConfig, isMcpMode } = require('./config');
const providerSettingsRepository = require('../features/common/repositories/providerSettings');

let config = null;

function getConfig() {
    if (!config) config = buildConfig();
    return config;
}

/**
 * Seed provider settings from the MCP env config. Must run after the database
 * is initialized and BEFORE the windows are created, so the header skips the
 * API-key wizard (areProvidersConfigured() → true).
 */
async function seedModelState() {
    const { stt } = getConfig();

    // STT: the configured transcription provider/model (existing Glass methods).
    const existingStt = await providerSettingsRepository.getByProvider(stt.provider);
    await providerSettingsRepository.upsert(stt.provider, {
        api_key: stt.apiKey,
        selected_llm_model: existingStt?.selected_llm_model || null,
        selected_stt_model: stt.model,
        created_at: existingStt?.created_at,
    });
    await providerSettingsRepository.setActiveProvider(stt.provider, 'stt');

    // LLM: always the connected MCP client model.
    const existingMcp = await providerSettingsRepository.getByProvider('mcp');
    await providerSettingsRepository.upsert('mcp', {
        api_key: 'mcp-client',
        selected_llm_model: 'mcp-client',
        selected_stt_model: null,
        created_at: existingMcp?.created_at,
    });
    await providerSettingsRepository.setActiveProvider('mcp', 'llm');

    // Existing mechanism to force the transcription language app-wide
    // (sttService: process.env.OPENAI_TRANSCRIBE_LANG || language).
    if (stt.language) {
        process.env.OPENAI_TRANSCRIBE_LANG = stt.language;
    }

    console.log(
        `[MCP] Model state seeded from env: stt=${stt.provider}/${stt.model} ` +
        `(lang=${stt.language}), llm=mcp-client`
    );
}

/**
 * Normal (non-MCP) starts: if a previous MCP run left the 'mcp' pseudo
 * provider active as LLM, drop it so the classic configuration flow applies.
 */
async function cleanupAfterMcpMode() {
    try {
        const activeLlm = await providerSettingsRepository.getActiveProvider('llm');
        if (activeLlm?.provider === 'mcp') {
            await providerSettingsRepository.remove('mcp');
            console.log('[MCP] Removed leftover mcp provider from a previous MCP-mode run.');
        }
    } catch (err) {
        console.warn('[MCP] Cleanup check failed:', err.message);
    }
}

/** Start the stdio MCP server. Call after the windows exist. */
async function startServer() {
    const { startMcpServer } = require('./server');
    await startMcpServer(getConfig());
}

module.exports = { isMcpMode, getConfig, seedModelState, cleanupAfterMcpMode, startServer };
