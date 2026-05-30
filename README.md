# samoagent

samoagent is a meeting I/O helper for AI agents.

It is not a full agent by itself. Give this CLI, a meeting URL, and the needed tokens to your AI agent, and the agent can join Zoom or Google Meet through Recall.ai, watch the live transcript, send meeting chat messages, and inspect the current call view on demand. In other words: samoagent gives an AI agent the plumbing it needs to be an active participant in calls.

## Setup

Requirements for the normal local workflow:

- Bun.
- `RECALL_API_KEY`.
- Authenticated `ngrok` HTTP tunnel.

```bash
bun install
export RECALL_API_KEY=...
bun run build
```

During development use `bun run samoagent ...`. After build or package install, use `samoagent ...`.

Why ngrok: Recall.ai needs a public HTTPS/WSS callback URL to deliver live transcripts and WebSocket video frames to the local samoagent server. The current `join` command creates that public callback with `ngrok http`. ngrok TCP is not required for normal `--ws-video` use; it is only needed for the optional RTMP path.

## Agent Workflow

```bash
samoagent join "https://meet.google.com/..." --ws-video --name Leo --dict postgresfm
samoagent watch
samoagent frame
samoagent chat "I can see the screen now."
samoagent leave
```

Run `watch` immediately after `join` and keep it running for the whole call. It prints one utterance per line:

```text
[2026-05-30 15:42:10] Speaker Name: words spoken in the meeting
```

Use `chat` only when you intentionally want to write into the meeting chat. Otherwise respond in your agent session.

## Frames

Use `join --ws-video` for normal agent use. Recall sends separate low-rate PNG frames over WebSocket. samoagent keeps the latest frame in memory; it does not write every frame to disk.

```bash
samoagent frame
```

`frame` writes the current frame only when called. By default it writes outside the repo:

```text
~/.samoagent/frames/latest.png
~/.samoagent/frames/latest.json
```

Use `--out` for an explicit export and `--archive` when you want a timestamped file with call/source metadata:

```bash
samoagent frame --out /tmp/call.png
samoagent frame --archive
```

Archive filenames include bot id, UTC timestamp, source type, and participant id.

## Important Flags

- `join --ws-video` - preferred no-TCP frame path for agents.
- `join --frame-dir DIR` - where on-demand frame files are written.
- `join --dict postgresfm` - Deepgram keyterm hints from `dictionaries/postgresfm.txt`.
- `join --transcript-dir DIR` - transcript location, default `~/.samoagent/`.
- `join --rtmp` - mixed-video RTMP path using ngrok TCP; requires ngrok card verification.
- `join --rtmp-url rtmp://host:1935/live/call` - explicit mixed-video RTMP receiver.

## Commands

- `join <meeting-url>` - start local server, ngrok tunnel, and Recall bot.
- `watch` - stream live transcript until `leave` writes the end sentinel.
- `chat <message>` - send meeting chat.
- `frame [--out FILE] [--archive]` - capture current call frame on demand.
- `status` - show current Recall bot status.
- `transcript` - fetch post-call transcript from Recall.
- `leave` - remove bot, stop local processes, and clean state.
- `dicts` - list keyword dictionaries.

## Storage

Runtime files live under `~/.samoagent/` by default:

- `state.json` - active bot id, process ids, URLs, paths.
- `transcript.txt` - live transcript.
- `frames/latest.png` and `frames/latest.json` - written only by `samoagent frame`.

Generated runtime files are ignored by git. Do not point `--frame-dir` or `--out` into the repo unless you intentionally want a local artifact.
