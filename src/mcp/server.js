/**
 * Glass MCP server — runs INSIDE the Electron app (started with
 * `electron . --mcp`). The complete app incl. teleprompter UI keeps working
 * exactly like the classic Electron variant; this module only adds the MCP
 * interface on stdio:
 *
 *  - tools drive the same services the UI buttons use (listen start/stop is
 *    fully in sync with the header button state),
 *  - app-internal LLM requests (Ask window, live summary) are delivered to
 *    the connected MCP client model via the llmBridge (sampling → channel
 *    push → polling) and its answer flows back into the UI/DB unchanged,
 *  - transcription keeps the existing provider methods, selected via env.
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const { McpLlmBridge } = require('./llmBridge');
const { transcribeFile } = require('./transcribeFile');
const { getSystemPrompt } = require('../features/common/prompts/promptBuilder');
const { profilePrompts } = require('../features/common/prompts/promptTemplates');
const packageJson = require('../../package.json');

const listenService = require('../features/listen/listenService');
const askService = require('../features/ask/askService');
const sessionRepository = require('../features/common/repositories/session');
const sttRepository = require('../features/listen/stt/repositories');
const summaryRepository = require('../features/listen/summary/repositories');
const askRepository = require('../features/ask/repositories');

function text(str) {
    return { content: [{ type: 'text', text: str }] };
}

function errorResult(err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
}

const wrap = handler => async (args = {}) => {
    try {
        return await handler(args);
    } catch (err) {
        return errorResult(err);
    }
};

function formatTranscriptLines(rows) {
    return rows.map(r => `[${r.speaker}] ${r.text}`);
}

async function startMcpServer(config) {
    const bridge = new McpLlmBridge({ timeoutS: config.llm.timeoutS });
    // The 'mcp' LLM provider (factory) picks the bridge up from here.
    global.__glassMcpLlmBridge = bridge;

    const server = new McpServer(
        { name: 'glass', version: packageJson.version },
        {
            capabilities: {
                // Channel capability (Claude Code research preview): lets the
                // app push its pending LLM requests into the client session.
                experimental: { 'claude/channel': {} },
            },
            instructions: [
                'Glass: live meeting/desktop assistant with its own on-screen UI (teleprompter).',
                `Transcription: ${config.stt.provider}/${config.stt.model} (lang: ${config.stt.language}).`,
                'YOU are the LLM of this app: when a <channel source="glass"> event announces a',
                'request id, or await_request/list_requests returns one, fetch it with get_request,',
                'generate the answer yourself and submit it with respond — it appears in the Glass',
                'UI and is stored, exactly like the classic app with a vendor LLM. While a listen',
                'session is active (or when the user asks something in the Ask window), keep an',
                'await_request long-poll running so summary/ask requests are answered promptly.',
                'listen_start/listen_stop mirror the header button 1:1.',
            ].join(' '),
        }
    );
    bridge.attach(server.server);

    // ── Listen (synced with the header button) ──────────────────────────────
    server.registerTool('listen_start', {
        description:
            'Start a listening session — identical to pressing "Listen" in the Glass header: ' +
            'the listen window opens, audio capture + realtime transcription and periodic ' +
            'summary requests begin. Language/provider come from the MCP env config.',
        inputSchema: {},
    }, wrap(async () => {
        if (listenService.isSessionActive()) {
            throw new Error('A listen session is already active.');
        }
        await listenService.handleListenRequest('Listen');
        return text(JSON.stringify({
            session_id: listenService.currentSessionId,
            stt: { provider: config.stt.provider, model: config.stt.model, language: config.stt.language },
            note: 'Keep an await_request long-poll running to answer summary/ask requests.',
        }));
    }));

    server.registerTool('listen_stop', {
        description:
            'Stop the active listening session — identical to pressing "Stop" in the header. ' +
            'Pass hide_window=true to also dismiss the listen window (the "Done" click).',
        inputSchema: {
            hide_window: z.boolean().optional().describe('Also hide the listen window afterwards (default false)'),
        },
    }, wrap(async ({ hide_window = false }) => {
        if (!listenService.isSessionActive()) {
            throw new Error('No active listen session.');
        }
        const sessionId = listenService.currentSessionId;
        await listenService.handleListenRequest('Stop');
        if (hide_window) {
            await listenService.handleListenRequest('Done');
        }
        const rows = await sttRepository.getAllTranscriptsBySessionId(sessionId);
        return text(JSON.stringify({ session_id: sessionId, transcript_lines: rows.length }));
    }));

    server.registerTool('listen_status', {
        description: 'Status of the listen feature: active session id, transcript line count, pending LLM requests. Cheap to call.',
        inputSchema: {},
    }, wrap(async () => {
        const active = listenService.isSessionActive();
        const sessionId = listenService.currentSessionId;
        const status = { active, session_id: sessionId || undefined };
        if (sessionId) {
            const session = await sessionRepository.getById(sessionId);
            if (session?.started_at) {
                status.duration_s = Math.round(Date.now() / 1000 - session.started_at);
            }
            status.transcript_lines = (await sttRepository.getAllTranscriptsBySessionId(sessionId)).length;
        }
        status.pending_requests = bridge.listPending();
        return text(JSON.stringify(status));
    }));

    server.registerTool('get_transcript', {
        description:
            'Read transcript lines of a session token-efficiently: pass the cursor from the previous ' +
            'call to receive only NEW lines. Response header "cursor=<next> total=<n>", then one ' +
            '"[Me]/[Them] text" line per utterance. Defaults to the active listen session.',
        inputSchema: {
            session_id: z.string().optional().describe('Session id (default: active listen session)'),
            cursor: z.number().int().min(0).optional().describe('Line index to start from (default 0)'),
            limit: z.number().int().min(1).max(500).optional().describe('Max lines (default 100)'),
        },
    }, wrap(async ({ session_id, cursor = 0, limit = 100 }) => {
        const sid = session_id || listenService.currentSessionId;
        if (!sid) throw new Error('No session_id given and no active listen session.');
        const rows = await sttRepository.getAllTranscriptsBySessionId(sid);
        const slice = rows.slice(cursor, cursor + limit);
        const nextCursor = cursor + slice.length;
        const header = `cursor=${nextCursor} total=${rows.length}`;
        if (slice.length === 0) return text(`${header}\n(no new lines)`);
        return text(`${header}\n${formatTranscriptLines(slice).join('\n')}`);
    }));

    // ── Ask (teleprompter) ──────────────────────────────────────────────────
    server.registerTool('ask', {
        description:
            'Submit a question to the Glass Ask feature — identical to typing it in the Ask ' +
            'window: a screenshot is captured, the Ask window opens, and the request is routed ' +
            'to YOU (the connected model). If the response contains a pending request, answer it ' +
            'immediately with respond(request_id, text); your answer appears in the teleprompter.',
        inputSchema: {
            prompt: z.string().describe('The user question'),
        },
    }, wrap(async ({ prompt }) => {
        if (!prompt.trim()) throw new Error('Empty prompt.');

        // Fire-and-forget: sendMessage resolves only after the answer has been
        // rendered, which in turn requires this client to answer — awaiting it
        // here would deadlock the tool call.
        askService.sendMessage(prompt).catch(err =>
            console.error('[MCP] ask dispatch failed:', err.message)
        );

        if (bridge.samplingSupported()) {
            return text('Ask dispatched; the answer arrives via MCP sampling and is shown in the Glass UI.');
        }

        // Queue mode: hand the request straight back so this same turn can
        // generate the answer without another round-trip.
        const record = await bridge.awaitNext(15);
        if (!record) {
            return text('Ask dispatched, but no request was queued (it may have failed — check listen_status).');
        }
        return { content: bridge.requestPayload(record) };
    }));

    server.registerTool('capture_screenshot', {
        description:
            'Capture the screen the user is looking at (same method the Ask feature uses) and ' +
            'return it as a downsized JPEG. Use for questions about the current screen content.',
        inputSchema: {},
    }, wrap(async () => {
        const shot = await askService.captureScreenshot({ quality: 'medium' });
        if (!shot.success) throw new Error(shot.error || 'Screenshot failed.');
        return { content: [{ type: 'image', data: shot.base64, mimeType: 'image/jpeg' }] };
    }));

    // ── LLM request bridge (the app asking YOU) ─────────────────────────────
    server.registerTool('await_request', {
        description:
            'Long-poll for the next app-internal LLM request (Ask question or live-summary ' +
            'update). Returns the full request (system prompt, content, possibly a screenshot) ' +
            'to answer with respond, or "(none)" on timeout. Keep calling this in a loop while ' +
            'a listen session is active.',
        inputSchema: {
            timeout_s: z.number().int().min(1).max(120).optional().describe('Seconds to wait (default 60)'),
        },
    }, wrap(async ({ timeout_s = 60 }) => {
        const record = await bridge.awaitNext(timeout_s);
        if (!record) return text('(none)');
        return { content: bridge.requestPayload(record) };
    }));

    server.registerTool('get_request', {
        description: 'Fetch a pending app-internal LLM request by id (announced via channel event or list_requests).',
        inputSchema: { request_id: z.string() },
    }, wrap(async ({ request_id }) => {
        const record = bridge.get(request_id);
        if (!record) throw new Error(`Unknown or already answered request: ${request_id}`);
        return { content: bridge.requestPayload(record) };
    }));

    server.registerTool('list_requests', {
        description: 'List pending app-internal LLM requests (id, kind, age).',
        inputSchema: {},
    }, wrap(async () => {
        const pending = bridge.listPending();
        return text(pending.length ? JSON.stringify(pending) : '(none)');
    }));

    server.registerTool('respond', {
        description:
            'Submit YOUR generated answer for a pending request. For kind=ask it streams into ' +
            'the teleprompter and is saved to the session; for kind=summary it must follow the ' +
            'format requested in the prompt (Summary Overview / Key Topic / Extended Explanation ' +
            '/ Suggested Questions) so the listen window can parse it.',
        inputSchema: {
            request_id: z.string(),
            text: z.string().describe('The answer, exactly as it should appear in the app'),
        },
    }, wrap(async ({ request_id, text: answer }) => {
        bridge.respond(request_id, answer);
        return text(`delivered ${request_id}`);
    }));

    // ── Batch transcription (existing STT methods, headless input) ──────────
    server.registerTool('transcribe_audio', {
        description:
            'Transcribe an audio file (any format ffmpeg can decode) using the configured STT ' +
            `provider (${config.stt.provider}/${config.stt.model}). Returns plain text.`,
        inputSchema: {
            file_path: z.string().describe('Absolute path to the audio file'),
            language: z.string().optional().describe('Language code (default from GLASS_LANGUAGE)'),
        },
    }, wrap(async ({ file_path, language }) => {
        const result = await transcribeFile(config, file_path, language);
        return text(`duration=${result.duration_s}s\n${result.text || '(no speech detected)'}`);
    }));

    // ── Session records (same SQLite data the app uses) ─────────────────────
    server.registerTool('list_sessions', {
        description: 'List stored sessions (newest first): id, type, state, start time, title.',
        inputSchema: {
            type: z.enum(['listen', 'ask']).optional().describe('Filter by session type'),
            limit: z.number().int().min(1).max(100).optional().describe('Max sessions (default 20)'),
        },
    }, wrap(async ({ type, limit = 20 }) => {
        let sessions = await sessionRepository.getAllByUserId();
        if (type) sessions = sessions.filter(s => s.session_type === type);
        sessions.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
        sessions = sessions.slice(0, limit);
        if (sessions.length === 0) return text('(no sessions)');
        const lines = sessions.map(s => {
            const state = s.ended_at ? 'ended' : 'active';
            const started = s.started_at ? new Date(s.started_at * 1000).toISOString() : '?';
            return `${s.id} | ${s.session_type} | ${state} | ${started} | ${s.title || ''}`;
        });
        return text(lines.join('\n'));
    }));

    server.registerTool('get_session', {
        description: 'Get one session: metadata, summary, ask exchanges, and optionally the full transcript.',
        inputSchema: {
            session_id: z.string(),
            include_transcript: z.boolean().optional().describe('Include full transcript (default false — prefer get_transcript with cursor)'),
        },
    }, wrap(async ({ session_id, include_transcript = false }) => {
        const session = await sessionRepository.getById(session_id);
        if (!session) throw new Error(`Unknown session: ${session_id}`);
        const [transcripts, aiMessages, summary] = await Promise.all([
            sttRepository.getAllTranscriptsBySessionId(session_id),
            askRepository.getAllAiMessagesBySessionId(session_id),
            summaryRepository.getSummaryBySessionId(session_id),
        ]);
        let body = JSON.stringify({
            ...session,
            transcript_lines: transcripts.length,
            summary: summary || undefined,
            ai_messages: aiMessages.map(m => ({ role: m.role, content: m.content })),
        }, null, 1);
        if (include_transcript) {
            body += '\n---transcript---\n' + formatTranscriptLines(transcripts).join('\n');
        }
        return text(body);
    }));

    server.registerTool('delete_session', {
        description: 'Delete a session including transcript, summary and ask messages. Irreversible.',
        inputSchema: { session_id: z.string() },
    }, wrap(async ({ session_id }) => {
        if (listenService.currentSessionId === session_id && listenService.isSessionActive()) {
            throw new Error('Session is currently active — call listen_stop first.');
        }
        const result = await sessionRepository.deleteWithRelatedData(session_id);
        if (result && result.success === false) throw new Error(result.error || `Could not delete ${session_id}`);
        return text(`deleted ${session_id}`);
    }));

    // ── Prompt profiles (unchanged Glass prompt builder) ────────────────────
    const profileDescriptions = {
        interview: 'Live job-interview copilot: factual, confident first-person answers.',
        pickle_glass: 'General Glass assistant profile: define/answer/advise from screen+audio context.',
        sales: 'Sales-call copilot: value-focused replies and objection handling.',
        meeting: 'Meeting copilot: clarifications, recaps, decisions and follow-ups.',
        presentation: 'Presentation copilot: concise speaker support and Q&A handling.',
        negotiation: 'Negotiation copilot: strategic, win-win oriented responses.',
        pickle_glass_analysis: 'Screen+conversation analysis profile (used by the Ask feature).',
    };
    for (const profile of Object.keys(profilePrompts)) {
        server.registerPrompt(profile, {
            description: profileDescriptions[profile] || `Glass prompt profile "${profile}"`,
            argsSchema: {
                context: z.string().optional().describe('User-provided context (goals, background, transcript excerpt)'),
            },
        }, ({ context }) => ({
            messages: [{
                role: 'user',
                content: { type: 'text', text: getSystemPrompt(profile, context || '', false) },
            }],
        }));
    }

    // MCP server lifecycle: the app lives as long as the client connection.
    // Quitting on disconnect lets the client respawn a fresh instance without
    // hitting the single-instance lock.
    server.server.onclose = () => {
        console.error('[MCP] Client disconnected — shutting down Glass.');
        try {
            require('electron').app.quit();
        } catch {
            process.exit(0);
        }
    };

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log(
        `[MCP] Server connected on stdio (stt=${config.stt.provider}/${config.stt.model}, ` +
        `lang=${config.stt.language}, llm=mcp-client, sampling=${bridge.samplingSupported()})`
    );
    return server;
}

module.exports = { startMcpServer };
