# Glass MCP Mode

Started with `--mcp`, the **complete Glass Electron app** — all windows, the
teleprompter, Listen/Ask, session records — runs exactly like the classic variant, with
three differences:

1. **No setup wizard / API-key UI.** Provider settings are seeded from environment
   variables in the MCP client config on every start.
2. **Transcription (STT) keeps the existing Glass methods and model selection**
   (OpenAI / Gemini / Deepgram / local Whisper incl. auto-download), chosen via
   `GLASS_STT_PROVIDER` / `GLASS_STT_MODEL` instead of the settings UI.
3. **The LLM is the model connected through MCP** (e.g. Claude via Claude Code).
   Ask answers and live summaries are no longer fetched from a vendor API with an API
   key — the app's requests are delivered to the MCP client model and its answers flow
   back into the teleprompter/DB unchanged. Your normal Claude subscription covers the
   usage; no OAuth-token extraction, no ToS gray areas.

An MCP server on stdio additionally exposes the app's features as tools, fully in sync
with the UI (the `listen_start`/`listen_stop` tools drive the same code path as the
header button, and button state follows).

## Setup

Build once (installs deps, builds renderer + web assets):

```bash
npm run setup        # or: npm install && npm run build:all
```

Register Glass in the MCP client config — e.g. Claude Code `.mcp.json` or Claude
Desktop `claude_desktop_config.json`. Spawn the Electron binary directly (not via
`npm`, which would write to stdout and corrupt the MCP stream):

```json
{
  "mcpServers": {
    "glass": {
      "command": "/absolute/path/to/glass/node_modules/.bin/electron",
      "args": ["/absolute/path/to/glass", "--mcp"],
      "env": {
        "GLASS_STT_PROVIDER": "whisper",
        "GLASS_STT_MODEL": "whisper-base",
        "GLASS_LANGUAGE": "de"
      }
    }
  }
}
```

On Windows use `node_modules\\.bin\\electron.cmd`. If the app needs longer than the
client's MCP startup timeout on first launch (Whisper model download), raise it (Claude
Code: `MCP_TIMEOUT`). For a manual start in a terminal: `npm run mcp`.

Cloud STT instead of local Whisper:

```json
"env": {
  "GLASS_STT_PROVIDER": "deepgram",
  "GLASS_STT_MODEL": "nova-3",
  "DEEPGRAM_API_KEY": "dg_…",
  "GLASS_LANGUAGE": "de"
}
```

## Configuration (all via MCP `env`, no UI)

| Variable | Default | Description |
| --- | --- | --- |
| `GLASS_STT_PROVIDER` | `whisper` | `openai`, `gemini`, `deepgram`, `whisper` (local) |
| `GLASS_STT_MODEL` | per provider | e.g. `gpt-4o-mini-transcribe`, `gemini-live-2.5-flash-preview`, `nova-3`, `whisper-tiny/base/small/medium` |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` / `DEEPGRAM_API_KEY` | – | Key for the chosen cloud STT provider |
| `GLASS_STT_API_KEY` | – | Provider-agnostic key override |
| `GLASS_LANGUAGE` | `en` | Transcription language (applies to UI- and MCP-started sessions) |
| `GLASS_LLM_TIMEOUT_S` | `300` | How long the app waits for the MCP client model per request |
| `GLASS_WHISPER_THREADS` / `GLASS_WHISPER_BEAM_SIZE` | auto / 1 | Local whisper.cpp tuning |
| `GLASS_FFMPEG_PATH` | `ffmpeg` | Only needed for the `transcribe_audio` tool |

The classic start (`npm start`) is unchanged and keeps the wizard/settings flow; the
seeded MCP state is cleaned up automatically on the next classic start.

## How the app talks to "its" LLM

The app registers an internal `mcp` LLM provider. When Ask or the live summary needs a
completion, the request (system prompt, user prompt, screenshot) goes to the connected
client model over the best available path:

1. **MCP sampling** (`sampling/createMessage`) — used automatically if the client
   supports it. Claude Code currently does not
   ([#1785](https://github.com/anthropics/claude-code/issues/1785)).
2. **Channel push** — the server declares the `claude/channel` capability and announces
   each pending request as a channel event. Start Claude Code with
   `claude --dangerously-load-development-channels server:glass`
   (channels are a research preview) and requests wake the session automatically:
   Claude fetches the request with `get_request`, answers with `respond`, and the
   answer appears in the teleprompter.
3. **Polling** — works in every MCP client without preview features: the model keeps an
   `await_request` long-poll running (e.g. while a listen session is active) and
   answers with `respond`.

If no client answers within `GLASS_LLM_TIMEOUT_S`, the request fails visibly in the UI,
same as a vendor-API error in the classic app.

## Tools

| Tool | Purpose |
| --- | --- |
| `listen_start` / `listen_stop` / `listen_status` | Start/stop listening — same code path as the header button, UI state stays in sync. `listen_stop` accepts `hide_window`. |
| `get_transcript` | Cursor-based transcript read (only new lines per call) from the same SQLite data the app uses. |
| `ask` | Submit a question to the Ask feature (screenshot + teleprompter, like typing in the Ask window). In polling mode the pending request is returned directly so the model can `respond` in the same turn. |
| `await_request` / `get_request` / `list_requests` / `respond` | The LLM request bridge described above. |
| `capture_screenshot` | Screenshot via the app's own capture path. |
| `transcribe_audio` | Batch-transcribe an audio file with the configured STT provider. |
| `list_sessions` / `get_session` / `delete_session` | Browse/manage the app's session records (transcripts, summaries, ask exchanges). |

MCP prompts: the Glass prompt profiles (`interview`, `meeting`, `sales`,
`presentation`, `negotiation`, `pickle_glass`, `pickle_glass_analysis`) generated by the
unchanged prompt builder, each with an optional `context` argument.

## Typical flow (Claude Code, polling mode)

1. User: *"Starte eine Listen-Session und bediene Glass."*
2. Claude: `listen_start` → keeps `await_request(timeout_s=60)` running.
3. Glass transcribes (UI shows live transcript). Every few turns the app queues a
   summary request → Claude receives it, generates the structured summary, `respond` →
   the listen window renders it.
4. The user types a question into the Ask window (or Claude calls `ask`) → request
   arrives with screenshot → Claude answers → teleprompter shows it.
5. `listen_stop` (or the user presses Stop — both stay in sync).

With channels enabled, step 2's polling loop is unnecessary — events arrive by
themselves.

## Notes

- One instance: Glass keeps its single-instance lock. Close a classic instance before
  connecting via MCP. If the MCP client disconnects, the app quits so the client can
  respawn it cleanly.
- All logging goes to stderr in MCP mode; stdout belongs to the MCP transport.
- Data lives in the same SQLite database as the classic app — sessions recorded via MCP
  show up in the web UI and vice versa.
