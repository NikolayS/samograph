# samoagent

samoagent is a meeting I/O helper for AI agents.

It is not a full agent by itself. Give this CLI, a meeting URL, and the needed tokens to your AI agent, and the agent can join Zoom or Google Meet through Recall.ai, watch the live transcript, send meeting chat messages, and inspect the current call view on demand. In other words: samoagent gives an AI agent the plumbing it needs to be an active participant in calls.

## Setup

Requirements for the normal local workflow:

- Bun.
- `RECALL_API_KEY`.
- Authenticated `ngrok` HTTP tunnel. The free ngrok plan should be enough for personal use with the normal `--ws-video` path.

```bash
bun install
export RECALL_API_KEY=...
bun run build
```

During development use `bun run samoagent ...`. After build or package install, use `samoagent ...`.

## What It Provides

samoagent gives an AI agent a small set of meeting tools:

- `join` - bring a Recall.ai bot into a Zoom or Google Meet call.
- `watch` - stream live transcript lines to the agent.
- `chat` - send a deliberate message into the meeting chat.
- `frame` - export the current call view on demand.
- `leave` - remove the bot and clean up local state.

The agent still decides what to say, when to inspect a frame, and how to use the meeting context. samoagent is the local adapter that exposes those call capabilities.

```text
AI agent
  | runs CLI tools
  v
samoagent on your machine
  | starts bot + local callback server
  v
Recall.ai bot in Zoom/Meet
  | transcript, chat, WebSocket video events
  v
samoagent watch/chat/frame
```

## Integration

For the normal local workflow, `join` starts a local callback server and exposes it with `ngrok http` so Recall.ai can deliver HTTPS/WSS events back to your machine.

Free ngrok HTTP should be enough for personal use with the default `--ws-video` path. ngrok TCP is not required for normal use; it is only needed for the optional RTMP path and may require card verification.

Webhook and frame routes are token-protected, and default runtime files stay under `~/.samoagent/`.

## Agent Workflow

```bash
samoagent join "https://meet.google.com/..." --name Leo --dict postgresfm
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

Frame capture is on by default. Recall sends separate PNG frames over WebSocket; samoagent keeps the latest in memory and only writes to disk when you call `frame`.

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

- `join --no-ws-video` - disable the default WebSocket frame path (e.g. when using RTMP instead).
- `join --frame-dir DIR` - where on-demand frame files are written.
- `join --dict postgresfm` - Deepgram keyterm hints from `dictionaries/postgresfm.txt`.
- `join --transcript-dir DIR` - transcript location, default `~/.samoagent/`.
- `join --rtmp` - mixed-video RTMP path using ngrok TCP; may require ngrok card verification.
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
