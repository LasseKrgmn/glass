/**
 * Bridge between the app-internal LLM calls (Ask, live summary) and the LLM
 * client connected to the Glass MCP server.
 *
 * Instead of calling a vendor API (OpenAI/Anthropic/…) with an API key, the
 * app's requests are answered by the model that is using this MCP server —
 * e.g. Claude via Claude Code. Three delivery paths, best available wins:
 *
 *  1. MCP sampling (`sampling/createMessage`) when the client declares the
 *     capability — fully automatic.
 *  2. Channel push: a `notifications/claude/channel` event announces the
 *     request in the client session (Claude Code `--channels` /
 *     `--dangerously-load-development-channels`); the model then fetches it
 *     with `get_request` and answers with `respond`.
 *  3. Polling: the model long-polls `await_request` and answers with
 *     `respond` (works in every MCP client, no preview features).
 *
 * Requests carry the exact same content the Electron variant would have sent
 * to the vendor API: system prompt, user prompt and the screenshot.
 */
const crypto = require('crypto');

/**
 * Convert OpenAI-style chat messages (what askService/summaryService build)
 * into { systemPrompt, parts } where parts is a list of
 * { type:'text', text } / { type:'image', data, mimeType } blocks.
 */
function convertMessages(messages) {
    let systemPrompt = '';
    const parts = [];

    for (const msg of messages || []) {
        if (msg.role === 'system') {
            systemPrompt += (systemPrompt ? '\n\n' : '') + msg.content;
            continue;
        }
        const prefix = msg.role && msg.role !== 'user' ? `[${msg.role}] ` : '';
        if (typeof msg.content === 'string') {
            parts.push({ type: 'text', text: prefix + msg.content });
            continue;
        }
        for (const item of msg.content || []) {
            if (item.type === 'text') {
                parts.push({ type: 'text', text: prefix + item.text });
            } else if (item.type === 'image_url') {
                const url = item.image_url?.url || '';
                const match = url.match(/^data:([^;]+);base64,(.*)$/s);
                if (match) {
                    parts.push({ type: 'image', data: match[2], mimeType: match[1] });
                }
            }
        }
    }
    return { systemPrompt, parts };
}

class McpLlmBridge {
    constructor({ timeoutS = 300 } = {}) {
        this.timeoutS = timeoutS;
        this.mcpServer = null;        // low-level Server (SDK)
        this.pending = new Map();     // id -> request record
        this.waiters = [];            // long-poll resolvers from await_request
    }

    attach(server) {
        this.mcpServer = server;
    }

    samplingSupported() {
        try {
            return !!this.mcpServer?.getClientCapabilities()?.sampling;
        } catch {
            return false;
        }
    }

    /**
     * Ask the MCP client model. Returns the answer text.
     * @param {Array} messages OpenAI-style messages
     * @param {{maxTokens?: number, kind?: string}} opts
     */
    async request(messages, { maxTokens = 2048, kind = 'ask' } = {}) {
        if (!this.mcpServer) {
            throw new Error('MCP client is not connected yet.');
        }
        const converted = convertMessages(messages);

        if (this.samplingSupported()) {
            return await this._viaSampling(converted, maxTokens);
        }
        return await this._viaQueue(converted, { maxTokens, kind });
    }

    async _viaSampling({ systemPrompt, parts }, maxTokens) {
        const samplingMessages = parts.map(part => ({
            role: 'user',
            content: part.type === 'image'
                ? { type: 'image', data: part.data, mimeType: part.mimeType }
                : { type: 'text', text: part.text },
        }));
        const result = await this.mcpServer.createMessage({
            messages: samplingMessages,
            systemPrompt: systemPrompt || undefined,
            maxTokens,
            includeContext: 'none',
        });
        const text = result?.content?.type === 'text' ? result.content.text : '';
        if (!text) throw new Error('MCP sampling returned no text.');
        return text;
    }

    _viaQueue(converted, { maxTokens, kind }) {
        const id = crypto.randomBytes(4).toString('hex');
        const firstText = converted.parts.find(p => p.type === 'text')?.text || '';

        return new Promise((resolve, reject) => {
            const record = {
                id,
                kind,
                maxTokens,
                converted,
                createdAt: Date.now(),
                resolve,
                reject,
                timer: setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error(
                        `No answer from the MCP client model within ${this.timeoutS}s. ` +
                        'Make sure the connected model handles glass requests ' +
                        '(channel events or await_request polling).'
                    ));
                }, this.timeoutS * 1000),
            };
            this.pending.set(id, record);

            // Wake a long-poller if one is waiting.
            const waiter = this.waiters.shift();
            if (waiter) waiter(record);

            // Push a channel event (silently dropped if channels are not active).
            this._notifyChannel(record, firstText);
        });
    }

    _notifyChannel(record, firstText) {
        const excerpt = firstText.replace(/\s+/g, ' ').slice(0, 300);
        this.mcpServer.notification({
            method: 'notifications/claude/channel',
            params: {
                content:
                    `Glass ${record.kind} request ${record.id}: "${excerpt}"\n` +
                    `Call get_request with request_id="${record.id}" for the full context ` +
                    `(may include a screenshot), then answer with respond.`,
                meta: { request_id: record.id, kind: record.kind },
            },
        }).catch(() => { /* channel not registered — polling still works */ });
    }

    /** Tool payload (content blocks) for a pending request. */
    requestPayload(record) {
        const { systemPrompt, parts } = record.converted;
        const content = [];
        const header =
            `request_id=${record.id} kind=${record.kind}\n` +
            `Answer this request by calling respond(request_id="${record.id}", text=...). ` +
            `Respond exactly as instructed below — your text is shown 1:1 in the Glass UI.\n\n` +
            (systemPrompt ? `--- system prompt ---\n${systemPrompt}\n\n` : '') +
            '--- request ---';
        content.push({ type: 'text', text: header });
        for (const part of parts) {
            content.push(part.type === 'image'
                ? { type: 'image', data: part.data, mimeType: part.mimeType }
                : { type: 'text', text: part.text });
        }
        return content;
    }

    /** Long-poll for the next pending request. Resolves null on timeout. */
    awaitNext(timeoutS = 60) {
        const oldest = [...this.pending.values()].find(r => !r.claimed);
        if (oldest) {
            oldest.claimed = true;
            return Promise.resolve(oldest);
        }
        return new Promise(resolve => {
            const waiter = record => {
                clearTimeout(timer);
                record.claimed = true;
                resolve(record);
            };
            const timer = setTimeout(() => {
                const idx = this.waiters.indexOf(waiter);
                if (idx !== -1) this.waiters.splice(idx, 1);
                resolve(null);
            }, timeoutS * 1000);
            this.waiters.push(waiter);
        });
    }

    get(id) {
        return this.pending.get(id) || null;
    }

    listPending() {
        return [...this.pending.values()].map(r => ({
            request_id: r.id,
            kind: r.kind,
            age_s: Math.round((Date.now() - r.createdAt) / 1000),
        }));
    }

    respond(id, text) {
        const record = this.pending.get(id);
        if (!record) {
            throw new Error(`Unknown or already answered request: ${id}`);
        }
        this.pending.delete(id);
        clearTimeout(record.timer);
        record.resolve(text);
    }

    fail(id, message) {
        const record = this.pending.get(id);
        if (!record) return;
        this.pending.delete(id);
        clearTimeout(record.timer);
        record.reject(new Error(message));
    }
}

module.exports = { McpLlmBridge, convertMessages };
