/**
 * "mcp" LLM provider — routes the app's LLM requests (Ask, live summary) to
 * the model connected to the Glass MCP server instead of a vendor API.
 *
 * The actual transport lives in src/mcp/llmBridge.js; the running bridge
 * instance is published on global.__glassMcpLlmBridge by the MCP server
 * bootstrap. This module only adapts it to the provider interface the
 * factory expects (chat / streamChat), so askService and summaryService work
 * unchanged.
 */

function getBridge() {
    const bridge = (typeof global !== 'undefined') ? global.__glassMcpLlmBridge : null;
    if (!bridge) {
        throw new Error(
            'MCP client model is not available. Start Glass in MCP mode (--mcp) ' +
            'and connect an MCP client (e.g. Claude Code).'
        );
    }
    return bridge;
}

class MCPBridgeProvider {
    static async validateApiKey() {
        // No key — the connected MCP client provides the model.
        return { success: true };
    }
}

function createLLM({ maxTokens = 2048 } = {}) {
    return {
        chat: async messages => {
            const content = await getBridge().request(messages, { maxTokens, kind: 'summary' });
            return { content, raw: { provider: 'mcp' } };
        },
        generateContent: async parts => {
            const messages = [];
            let systemPrompt = '';
            const userContent = [];
            for (const part of parts) {
                if (typeof part === 'string') {
                    if (systemPrompt === '' && part.includes('You are')) systemPrompt = part;
                    else userContent.push({ type: 'text', text: part });
                } else if (part.inlineData) {
                    userContent.push({
                        type: 'image_url',
                        image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` },
                    });
                }
            }
            if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
            if (userContent.length > 0) messages.push({ role: 'user', content: userContent });

            const content = await getBridge().request(messages, { maxTokens, kind: 'ask' });
            return { response: { text: () => content } };
        },
    };
}

function createStreamingLLM({ maxTokens = 2048 } = {}) {
    return {
        streamChat: async messages => {
            const content = await getBridge().request(messages, { maxTokens, kind: 'ask' });

            // askService consumes an OpenAI-style SSE body — emulate one. The
            // text is split into small chunks so the Ask window still renders
            // progressively like with a real streaming API.
            const encoder = new TextEncoder();
            const chunks = content.match(/[\s\S]{1,120}/g) || [];
            const stream = new ReadableStream({
                start(controller) {
                    for (const chunk of chunks) {
                        const payload = JSON.stringify({ choices: [{ delta: { content: chunk } }] });
                        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
                    }
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                },
            });
            return new Response(stream, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
            });
        },
    };
}

module.exports = {
    MCPBridgeProvider,
    createLLM,
    createStreamingLLM,
};
