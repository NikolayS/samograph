# samoagent

> Build agents that show up to the meeting, not just the codebase.

samoagent lets your AI agent (Claude Code, Codex, and others) join Zoom and Google Meet calls as an active participant — listening, responding, and taking action in real time.

Give this CLI, a meeting URL, and the needed tokens to your AI agent. samoagent handles the meeting plumbing through Recall.ai: joining calls, streaming the live transcript, sending explicit chat messages, and inspecting the current call view on demand.

## Setup

Requirements:

- Bun.
- `RECALL_API_KEY`.
- `ngrok` installed and authenticated (free plan). `join` starts and manages ngrok automatically — you don't run it yourself. ngrok is optional when using `--webhook-base` with an external tunnel (localtunnel, cloudflared, etc.).

Install the CLI from npm:

```bash
npm install -g samoagent
export RECALL_API_KEY=...
samoagent join "https://meet.google.com/..." --name Leo
```

During development use `bun install`, `bun run build`, then `bun run samoagent ...`.

## What It Provides

samoagent gives an AI agent a small set of meeting tools:

- `join` - bring a Recall.ai bot into a Zoom or Google Meet call.
- `watch` - stream live transcript lines to the agent.
- `notes` - maintain a structured Google Doc agenda with important points, decisions, and action items.
- `chat` - send a deliberate message into the meeting chat.
- `presence` - update the bot camera state shown in the meeting.
- `frame` - export the current call view on demand.
- `leave` - remove the bot and clean up local state.
- `status` - show the current Recall bot state.
- `transcript` - print the transcript (local file, or post-call from Recall).
- `screenshot` - capture the local Mac screen (fallback when no call frame is available).
- `dicts` - list available Deepgram keyword dictionaries.
- `doctor` - check local prerequisites before joining a call.

The agent still decides what to say, when to inspect a frame, and how to use the meeting context. samoagent is the local adapter that exposes those call capabilities.

```text
AI agent
  | runs CLI tools
  v
samoagent on your machine
  | starts bot + local callback server + ngrok tunnel (or external tunnel via --webhook-base)
  v
Recall.ai bot in Zoom/Meet
  | transcript, chat, WebSocket video events
  v
samoagent watch/notes/chat/frame
```

## Integration

`join` starts a local callback server and exposes it with `ngrok http` so Recall.ai can deliver HTTPS/WSS events back to your machine. The free ngrok HTTP plan is enough for normal use. Alternatively, pass `--webhook-base <URL>` to use an existing external tunnel (localtunnel, cloudflared, etc.) and skip spawning ngrok entirely.

ngrok TCP is only needed for the optional RTMP path (`--rtmp`) and requires a credit/debit card on file at ngrok.com (free plan — the card is not charged). The standard WebSocket frame path does not need TCP or card verification.

Webhook and frame routes are token-protected, and default runtime files stay under `~/.samoagent/`.

## Agent Workflow

```bash
samoagent join "https://meet.google.com/..." --name Leo --dict postgresfm
samoagent watch
samoagent notes init --doc-id 1abc... --credentials ~/.samoagent/google.json --title "Customer migration call"
samoagent notes point "Migration risk is the blocker" --speaker Alice
samoagent notes decision "Use logical replication for phase 1"
samoagent notes action "Open migration checklist issue" --owner Nik --due 2026-06-07
samoagent presence thinking "Checking the shared screen"
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

## Dynamic Bot Presence

`join` gives the Recall bot a token-protected local camera page through the same public tunnel used for webhooks. The page starts as `listening` and refreshes itself from the local callback server every second.

Update it from the agent loop:

```bash
samoagent presence listening
samoagent presence thinking "Checking logs"
samoagent presence speaking "Answering in chat"
samoagent presence acting "Opening PR review"
samoagent presence idle
```

Presence is in-memory runtime state. It is meant for lightweight meeting signaling, not persistence.

## Google Doc Notes

`notes` follows GitLab-style live doc meetings: the doc is an agenda and collaboration surface, not a transcript dump. The agent watches the transcript, decides what matters, then writes concise points into the right section.

```bash
export GOOGLE_DOC_ID=1abc...
export GOOGLE_APPLICATION_CREDENTIALS=~/.samoagent/google-service-account.json
samoagent notes init --title "Customer migration call"
samoagent notes point "Customer is blocked on cutover risk" --speaker Alice
samoagent notes decision "Run a shadow replay before scheduling cutover"
samoagent notes action "Create replay checklist issue" --owner Nik --due 2026-06-07
```

The credentials file must be a Google service-account JSON key, and the target doc must be shared with that service account's `client_email` as an editor.

If you really want raw transcript mirroring, make that explicit:

```bash
samoagent notes transcript --from-start
```

## Frames

Frame capture is on by default. Recall sends separate PNG frames over WebSocket; samoagent keeps the latest frames in memory, indexed by source, and only writes to disk when you call `frame`.

`frame` fails with `FRAME_UNAVAILABLE` if no frame has arrived yet — call it after the bot has been in the meeting for a few seconds.

```bash
samoagent frames
samoagent frame
```

By default it writes outside the repo:

```text
~/.samoagent/frames/latest.png
~/.samoagent/frames/latest.json
```

Use `--out` for an explicit path, or `--archive` to create a timestamped copy alongside the latest:

```bash
samoagent frame --source screen --out /tmp/screen.png
samoagent frame --source participant:100
samoagent frame --out /tmp/call.png
samoagent frame --archive
```

`frames` lists buffered source keys such as `type:screen_share` or `participant:100`. `frame --source` accepts those keys, plus aliases like `screen`, `screen_share`, and `webcam`.

Archive filenames include call id, UTC timestamp, source type, and participant id. Source type and participant id come from the Recall event metadata and may be `unknown` if Recall does not provide them.

## Important Flags

- `join --no-ws-video` - disable the default WebSocket frame path (e.g. when using RTMP instead).
- `join --webhook-base URL` - use an existing public tunnel (localtunnel, cloudflared quick tunnel, etc.) pointing at `--port` instead of starting ngrok. Useful when ngrok is unavailable or its free-tier bandwidth cap is hit (`ERR_NGROK_727`): run `npx localtunnel --port 8080`, then pass the printed `https://*.loca.lt` URL here.
- `join --variant web_4_core` - ask Recall to run the output-media webpage on a larger bot instance. Use this when the camera webpage reports low render FPS or looks choppy. `web` is the default Recall instance; `web_gpu` is available for WebGL-heavy pages.
- `join --frame-dir DIR` - where on-demand frame files are written.
- `join --dict postgresfm` - Deepgram keyterm hints from `dictionaries/postgresfm.txt`.
- `join --transcript-dir DIR` - timestamped transcript file location, default `~/.samoagent/`.
- `join --rtmp` - mixed-video RTMP path using ngrok TCP; requires ngrok card verification.
- `join --rtmp-url rtmp://host:1935/live/call` - explicit mixed-video RTMP receiver.
- `notes --doc-id ID` - Google Doc ID or URL for live meeting notes; defaults to `GOOGLE_DOC_ID`.
- `notes --credentials FILE` - Google service-account JSON; defaults to `GOOGLE_APPLICATION_CREDENTIALS`.
- `notes --section NAME` - section for `notes point`, such as `important`, `agenda`, `decisions`, or `actions`.
- `notes --speaker NAME` - speaker prefix for `notes point`.
- `notes --owner NAME` and `--due DATE` - action-item metadata.
- `notes --from-start` - with `notes transcript`, replay existing transcript lines before tailing live lines.
- `frame --source SOURCE` - select `latest`, `screen`, `webcam`, `type:<type>`, or `participant:<id>`.

## Commands

- `join <meeting-url>` - start local server, ngrok tunnel, and Recall bot.
- `watch` - stream live transcript until `leave` writes the end sentinel; exits immediately if no session is active.
- `notes init` - add a live meeting doc template.
- `notes point <text>` - add an important point under a section.
- `notes decision <text>` - add a decision.
- `notes action <text>` - add an action item.
- `notes transcript [--from-start]` - explicitly mirror raw transcript lines.
- `chat <message>` - send meeting chat.
- `presence <listening|thinking|speaking|acting|idle> [message]` - update the bot camera state; `thinking`/`speaking`/`acting` messages are shown as live activity on the camera page, and transcript webhooks add recent "heard" lines automatically.
- `frames` - list buffered WebSocket frame sources and metadata.
- `frame [--source SOURCE] [--out FILE] [--archive]` - write an in-memory frame to disk on demand.
- `status` - show bot id, name, Recall status code, transcript line count, transcript file path, and frame source metadata.
- `transcript` - print the Recall post-call transcript if available, otherwise print the local transcript file.
- `screenshot [--out FILE]` - capture the local Mac screen with `screencapture`; use as a fallback when frame is not available.
- `leave` - remove bot, stop local processes, and clean state.
- `dicts` - list keyword dictionaries.

## Storage

Runtime files live under `~/.samoagent/` by default:

- `state.json` - active bot id, process ids, URLs, paths.
- `YYYYMMDD_HHMMSS_transcript.txt` - per-call live transcript; `join` never overwrites older transcripts.
- `frames/latest.png` and `frames/latest.json` - written only by `samoagent frame`.

Generated runtime files are ignored by git. Do not point `--frame-dir` or `--out` into the repo unless you intentionally want a local artifact.

## License

Apache License 2.0. See [LICENSE](LICENSE).
