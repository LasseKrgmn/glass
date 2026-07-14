/**
 * File-based session storage for the headless MCP server.
 *
 * Mirrors the logical schema of the Electron app (sessions, transcripts,
 * summaries — see src/features/common/config/schema.js) but uses plain JSON /
 * JSONL files so the MCP server has no native-module (better-sqlite3)
 * dependency and can run under any Node runtime.
 *
 * Layout under GLASS_DATA_DIR (default ~/.glass/mcp):
 *   sessions.json            – array of session metadata
 *   transcripts/<id>.jsonl   – one JSON object per final transcript line
 *   summaries/<id>.json      – client-LLM generated summary for a session
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Storage {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.sessionsFile = path.join(dataDir, 'sessions.json');
        this.transcriptsDir = path.join(dataDir, 'transcripts');
        this.summariesDir = path.join(dataDir, 'summaries');

        fs.mkdirSync(this.transcriptsDir, { recursive: true });
        fs.mkdirSync(this.summariesDir, { recursive: true });
    }

    _readSessions() {
        try {
            return JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
        } catch {
            return [];
        }
    }

    _writeSessions(sessions) {
        const tmp = this.sessionsFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
        fs.renameSync(tmp, this.sessionsFile);
    }

    createSession(type = 'listen', title = null) {
        const now = Date.now();
        const session = {
            id: crypto.randomUUID(),
            title: title || `Session @ ${new Date(now).toISOString()}`,
            session_type: type,
            started_at: now,
            ended_at: null,
            updated_at: now,
        };
        const sessions = this._readSessions();
        sessions.push(session);
        this._writeSessions(sessions);
        return session;
    }

    getSession(id) {
        return this._readSessions().find(s => s.id === id) || null;
    }

    updateSession(id, patch) {
        const sessions = this._readSessions();
        const session = sessions.find(s => s.id === id);
        if (!session) return null;
        Object.assign(session, patch, { updated_at: Date.now() });
        this._writeSessions(sessions);
        return session;
    }

    endSession(id) {
        return this.updateSession(id, { ended_at: Date.now() });
    }

    listSessions({ type = null, limit = 20 } = {}) {
        let sessions = this._readSessions();
        if (type) sessions = sessions.filter(s => s.session_type === type);
        sessions.sort((a, b) => b.started_at - a.started_at);
        return sessions.slice(0, limit);
    }

    deleteSession(id) {
        const sessions = this._readSessions();
        const idx = sessions.findIndex(s => s.id === id);
        if (idx === -1) return false;
        sessions.splice(idx, 1);
        this._writeSessions(sessions);
        for (const file of [this._transcriptFile(id), this._summaryFile(id)]) {
            try { fs.unlinkSync(file); } catch { /* may not exist */ }
        }
        return true;
    }

    _transcriptFile(sessionId) {
        return path.join(this.transcriptsDir, `${sessionId}.jsonl`);
    }

    _summaryFile(sessionId) {
        return path.join(this.summariesDir, `${sessionId}.json`);
    }

    addTranscript(sessionId, { speaker, text }) {
        const entry = { speaker, text, ts: Date.now() };
        fs.appendFileSync(this._transcriptFile(sessionId), JSON.stringify(entry) + '\n');
        return entry;
    }

    readTranscripts(sessionId, { since = 0, limit = Infinity } = {}) {
        let lines;
        try {
            lines = fs.readFileSync(this._transcriptFile(sessionId), 'utf8').split('\n').filter(Boolean);
        } catch {
            return { entries: [], total: 0 };
        }
        const total = lines.length;
        const slice = lines.slice(since, limit === Infinity ? undefined : since + limit);
        const entries = slice.map((line, i) => ({ index: since + i, ...JSON.parse(line) }));
        return { entries, total };
    }

    countTranscripts(sessionId) {
        return this.readTranscripts(sessionId).total;
    }

    saveSummary(sessionId, summary) {
        const record = { ...summary, session_id: sessionId, generated_at: Date.now() };
        fs.writeFileSync(this._summaryFile(sessionId), JSON.stringify(record, null, 2));
        return record;
    }

    getSummary(sessionId) {
        try {
            return JSON.parse(fs.readFileSync(this._summaryFile(sessionId), 'utf8'));
        } catch {
            return null;
        }
    }
}

module.exports = Storage;
