#!/usr/bin/env node
/**
 * Glass MCP server — exposes the Glass feature set (listen/transcribe,
 * screen capture, sessions, summaries, prompt profiles) as Model Context
 * Protocol tools for autonomous use by an LLM client.
 *
 * Design notes:
 *  - No setup or settings UI. All configuration comes from environment
 *    variables in the MCP client config (see src/mcp/config.js / docs).
 *  - The client LLM is the "brain": Glass no longer calls its own LLM for
 *    Ask/answers or summaries. Instead the client pulls the context it needs
 *    (screenshot, transcript deltas) and writes its analysis back
 *    (save_summary). This is the most token-efficient split: transcripts are
 *    delivered incrementally via cursors, screenshots are downsized JPEGs.
 *  - Only transcription (STT) keeps the existing Glass provider methods and
 *    model selection (OpenAI / Gemini / Deepgram / local Whisper), chosen via
 *    GLASS_STT_PROVIDER / GLASS_STT_MODEL.
 */
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const { buildConfig } = require('./config');
const Storage = require('./storage');
const ListenSessionManager = require('./listenSession');
const { captureScreenshot } = require('./screenshot');
const { transcribeFile } = require('./transcribeFile');
const { getSystemPrompt } = require('../features/common/prompts/promptBuilder');
const { profilePrompts } = require('../features/common/prompts/promptTemplates');
const packageJson = require('../../package.json');

// The MCP transport owns stdout; anything the reused Glass services write via
// console.log would corrupt the JSON-RPC stream. Redirect all logging to stderr.
for (const level of ['log', 'info', 'warn', 'debug']) {
    console[level] = (...args) => console.error(...args);
}

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

async function main() {
    const config = buildConfig();
    const storage = new Storage(config.dataDir);
    const listenManager = new ListenSessionManager(config, storage);

    const server = new McpServer(
        { name: 'glass', version: packageJson.version },
        {
            instructions: [
                'Glass: real-time meeting/desktop context capture.',
                `STT: ${config.stt.provider}/${config.stt.model} (lang: ${config.stt.language}).`,
                'Typical flow: listen_start → poll get_transcript with the returned cursor',
                '(only new lines are sent) → analyze yourself → save_summary → listen_stop.',
                'Use capture_screenshot to see the user\'s screen. Use the prompt profiles',
                '(meeting, interview, sales, …) as system prompts for your analysis.',
            ].join(' '),
        }
    );

    // ── Listen (live transcription) ─────────────────────────────────────────
    server.registerTool('listen_start', {
        description:
            'Start a live listening session: captures audio (mic via ffmpeg' +
            (process.platform === 'darwin' ? ', system audio via SystemAudioDump' : '') +
            ') and transcribes it in real time with the configured STT provider. ' +
            'Transcript lines are persisted; read them incrementally with get_transcript.',
        inputSchema: {
            language: z.string().optional().describe('BCP-47/ISO language code for transcription (default from GLASS_LANGUAGE)'),
            title: z.string().optional().describe('Optional session title'),
        },
    }, wrap(async ({ language, title }) => {
        const result = await listenManager.start({ language, title });
        return text(JSON.stringify(result));
    }));

    server.registerTool('listen_stop', {
        description: 'Stop the active listening session and persist it. Returns duration and transcript line count.',
        inputSchema: {},
    }, wrap(async () => {
        const result = await listenManager.stop();
        return text(JSON.stringify(result));
    }));

    server.registerTool('listen_status', {
        description: 'Status of the active listening session (duration, line count, audio sources). Cheap to call.',
        inputSchema: {},
    }, wrap(async () => text(JSON.stringify(listenManager.status()))));

    server.registerTool('get_transcript', {
        description:
            'Read transcript lines of a session, token-efficiently: pass the cursor from the previous call ' +
            'to receive only NEW lines. Response starts with "cursor=<next> total=<n>", then one line per ' +
            'utterance: "[Me]/[Them] text". Defaults to the active listen session.',
        inputSchema: {
            session_id: z.string().optional().describe('Session id (default: active listen session)'),
            cursor: z.number().int().min(0).optional().describe('Line index to start from (from previous response). Default 0.'),
            limit: z.number().int().min(1).max(500).optional().describe('Max lines to return (default 100)'),
        },
    }, wrap(async ({ session_id, cursor = 0, limit = 100 }) => {
        const sid = session_id || listenManager.activeSessionId();
        if (!sid) throw new Error('No session_id given and no active listen session.');
        if (!storage.getSession(sid)) throw new Error(`Unknown session: ${sid}`);

        const { entries, total } = storage.readTranscripts(sid, { since: cursor, limit });
        const nextCursor = entries.length ? entries[entries.length - 1].index + 1 : cursor;
        const header = `cursor=${nextCursor} total=${total}`;
        if (entries.length === 0) return text(`${header}\n(no new lines)`);
        const lines = entries.map(e => `[${e.speaker}] ${e.text}`);
        return text(`${header}\n${lines.join('\n')}`);
    }));

    // ── Screen capture ──────────────────────────────────────────────────────
    server.registerTool('capture_screenshot', {
        description:
            'Capture the screen the user is looking at and return it as a downsized JPEG image ' +
            '(token-cheap). Use it to answer questions about what is currently on screen.',
        inputSchema: {
            height: z.number().int().min(64).max(2160).optional()
                .describe(`Target image height in px (default ${config.screenshot.height}; larger = more detail = more tokens)`),
            quality: z.number().int().min(10).max(100).optional()
                .describe(`JPEG quality (default ${config.screenshot.quality})`),
        },
    }, wrap(async ({ height, quality }) => {
        const shot = await captureScreenshot({
            height: height || config.screenshot.height,
            quality: quality || config.screenshot.quality,
        });
        return { content: [{ type: 'image', data: shot.base64, mimeType: shot.mimeType }] };
    }));

    // ── Batch transcription ─────────────────────────────────────────────────
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

    // ── Sessions / structured knowledge ─────────────────────────────────────
    server.registerTool('list_sessions', {
        description: 'List stored sessions (newest first): id, title, type, timestamps, line/summary info.',
        inputSchema: {
            type: z.enum(['listen', 'ask']).optional().describe('Filter by session type'),
            limit: z.number().int().min(1).max(100).optional().describe('Max sessions (default 20)'),
        },
    }, wrap(async ({ type, limit = 20 }) => {
        const sessions = storage.listSessions({ type, limit });
        if (sessions.length === 0) return text('(no sessions)');
        const lines = sessions.map(s => {
            const summary = storage.getSummary(s.id) ? ' summary=yes' : '';
            const state = s.ended_at ? 'ended' : 'active';
            return `${s.id} | ${s.session_type} | ${state} | ${new Date(s.started_at).toISOString()} | ` +
                `lines=${storage.countTranscripts(s.id)}${summary} | ${s.title}`;
        });
        return text(lines.join('\n'));
    }));

    server.registerTool('get_session', {
        description: 'Get one session: metadata, saved summary, and optionally the full transcript.',
        inputSchema: {
            session_id: z.string(),
            include_transcript: z.boolean().optional().describe('Include full transcript text (default false — prefer get_transcript with cursor)'),
        },
    }, wrap(async ({ session_id, include_transcript = false }) => {
        const session = storage.getSession(session_id);
        if (!session) throw new Error(`Unknown session: ${session_id}`);
        const out = {
            ...session,
            transcript_lines: storage.countTranscripts(session_id),
            summary: storage.getSummary(session_id) || undefined,
        };
        let body = JSON.stringify(out, null, 1);
        if (include_transcript) {
            const { entries } = storage.readTranscripts(session_id);
            body += '\n---transcript---\n' + entries.map(e => `[${e.speaker}] ${e.text}`).join('\n');
        }
        return text(body);
    }));

    server.registerTool('delete_session', {
        description: 'Delete a session including its transcript and summary. Irreversible.',
        inputSchema: { session_id: z.string() },
    }, wrap(async ({ session_id }) => {
        if (listenManager.activeSessionId() === session_id) {
            throw new Error('Session is currently active — call listen_stop first.');
        }
        if (!storage.deleteSession(session_id)) throw new Error(`Unknown session: ${session_id}`);
        return text(`deleted ${session_id}`);
    }));

    server.registerTool('save_summary', {
        description:
            'Persist YOUR analysis of a session (summary/action items) as structured knowledge. ' +
            'Call this with your own generated content — Glass does not run an LLM for this.',
        inputSchema: {
            session_id: z.string().optional().describe('Session id (default: active listen session)'),
            tldr: z.string().describe('Short summary of the session'),
            bullets: z.array(z.string()).optional().describe('Key points'),
            actions: z.array(z.string()).optional().describe('Action items'),
            title: z.string().optional().describe('Optionally set a better session title'),
        },
    }, wrap(async ({ session_id, tldr, bullets = [], actions = [], title }) => {
        const sid = session_id || listenManager.activeSessionId();
        if (!sid) throw new Error('No session_id given and no active listen session.');
        if (!storage.getSession(sid)) throw new Error(`Unknown session: ${sid}`);
        storage.saveSummary(sid, { tldr, bullet_json: bullets, action_json: actions, model: 'mcp-client' });
        if (title) storage.updateSession(sid, { title });
        return text(`saved summary for ${sid}`);
    }));

    // ── Prompt profiles (was: preset selection in the settings UI) ──────────
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
                content: {
                    type: 'text',
                    text: getSystemPrompt(profile, context || '', false),
                },
            }],
        }));
    }

    // ── Shutdown handling ────────────────────────────────────────────────────
    const shutdown = async () => {
        try {
            if (listenManager.isActive()) await listenManager.stop();
        } catch { /* best effort */ }
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(
        `[glass-mcp] ready (stt=${config.stt.provider}/${config.stt.model}, ` +
        `capture=${config.capture.mode}, data=${config.dataDir})`
    );
}

main().catch(err => {
    console.error('[glass-mcp] fatal:', err.message);
    process.exit(1);
});
