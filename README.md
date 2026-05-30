# samoagent

samoagent is a meeting I/O helper for AI agents.

It is not a full agent by itself. Give this CLI, a meeting URL, and the needed tokens to your AI agent, and the agent can join Zoom or Google Meet through Recall.ai, watch the live transcript, send meeting chat messages, and inspect the current call view on demand. In other words: samoagent gives an AI agent the plumbing it needs to be an active participant in calls.

## Setup

Requirements:

- Bun.
- `RECALL_API_KEY`.
- `ngrok` installed and authenticated (free plan). `join` starts and manages ngrok automatically — you don't run it yourself.

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
- `status` - show the current Recall bot state.
- `transcript` - print the transcript (local file, or post-call from Recall).
- `screenshot` - capture the local Mac screen (fallback when no call frame is available).
- `dicts` - list available Deepgram keyword dictionaries.

The agent still decides what to say, when to inspect a frame, and how to use the meeting context. samoagent is the local adapter that exposes those call capabilities.

```text
AI agent
  | runs CLI tools
  v
samoagent on your machine
  | starts bot + local callback server + ngrok tunnel
  v
Recall.ai bot in Zoom/Meet
  | transcript, chat, WebSocket video events
  v
samoagent watch/chat/frame
```

## Integration

`join` starts a local callback server and exposes it with `ngrok http` so Recall.ai can deliver HTTPS/WSS events back to your machine. The free ngrok HTTP plan is enough for normal use.

ngrok TCP is only needed for the optional RTMP path (`--rtmp`) and requires a credit/debit card on file at ngrok.com (free plan — the card is not charged). The standard WebSocket frame path does not need TCP or card verification.

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

`watch` exits automatically when `leave` is run. If there is no active session, it prints `No active session.` to stderr and exits.

Use `chat` only when you intentionally want to write into the meeting chat. Otherwise respond in your agent session.

## Frames

Frame capture is on by default. Recall sends separate PNG frames over WebSocket; samoagent keeps the latest in memory and only writes to disk when you call `frame`.

`frame` fails with `FRAME_UNAVAILABLE` if no frame has arrived yet — call it after the bot has been in the meeting for a few seconds.

```bash
samoagent frame
```

By default it writes outside the repo:

```text
~/.samoagent/frames/latest.png
~/.samoagent/frames/latest.json
```

Use `--out` for an explicit path, or `--archive` to create a timestamped copy alongside the latest:

```bash
samoagent frame --out /tmp/call.png
samoagent frame --archive
```

Archive filenames include call id, UTC timestamp, source type, and participant id. Source type and participant id come from the Recall event metadata and may be `unknown` if Recall does not provide them.

## Important Flags

- `join --no-ws-video` - disable the default WebSocket frame path (e.g. when using RTMP instead).
- `join --frame-dir DIR` - where on-demand frame files are written.
- `join --dict postgresfm` - Deepgram keyterm hints from `dictionaries/postgresfm.txt`.
- `join --transcript-dir DIR` - transcript location, default `~/.samoagent/`.
- `join --rtmp` - mixed-video RTMP path using ngrok TCP; requires ngrok card verification.
- `join --rtmp-url rtmp://host:1935/live/call` - explicit mixed-video RTMP receiver.

## Commands

- `join <meeting-url>` - start local server, ngrok tunnel, and Recall bot.
- `watch` - stream live transcript until `leave` writes the end sentinel; exits immediately if no session is active.
- `chat <message>` - send meeting chat.
- `frame [--out FILE] [--archive]` - write latest in-memory frame to disk on demand.
- `status` - show bot id, name, Recall status code, transcript line count, and transcript file path.
- `transcript` - print the Recall post-call transcript if available, otherwise print the local transcript file.
- `screenshot [--out FILE]` - capture the local Mac screen with `screencapture`; use as a fallback when frame is not available.
- `leave` - remove bot, stop local processes, and clean state.
- `dicts` - list keyword dictionaries.

## Storage

Runtime files live under `~/.samoagent/` by default:

- `state.json` - active bot id, process ids, URLs, paths.
- `transcript.txt` - live transcript.
- `frames/latest.png` and `frames/latest.json` - written only by `samoagent frame`.

Generated runtime files are ignored by git. Do not point `--frame-dir` or `--out` into the repo unless you intentionally want a local artifact.

## License

Apache License 2.0. See [LICENSE](LICENSE).
