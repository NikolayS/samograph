# samoagent

Meeting CLI for agents. It joins Zoom or Google Meet through Recall.ai, streams the live transcript, lets the agent send chat messages, and can capture the current call view on demand.

## Setup

Requirements: Bun, `RECALL_API_KEY`, and authenticated `ngrok`.

```bash
bun install
export RECALL_API_KEY=...
bun run build
```

During development use `bun run samoagent ...`. After build or package install, use `samoagent ...`.

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
