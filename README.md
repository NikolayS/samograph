# samograph

> Build agents that show up to the meeting, not just the codebase.

<p align="center">
  <img src="docs/avatar.png" alt="samograph robot" width="420">
</p>

samograph lets your AI agent (Claude Code, Codex, and others) join Zoom and Google Meet calls as an active participant — listening, responding, and taking action in real time.

Give this CLI, a meeting URL, and the needed tokens to your AI agent. samograph handles the meeting plumbing through Recall.ai: joining calls, streaming the live transcript, sending explicit chat messages, and inspecting the current call view on demand.

## Setup

Requirements:

- Bun.
- `RECALL_API_KEY`.
- `ngrok` installed and authenticated (free plan is enough for transcription; the presence camera needs an interstitial-free tunnel — see Dynamic Bot Presence). `join` starts and manages ngrok automatically — you don't run it yourself. ngrok is optional when using `--webhook-base` with an external tunnel (localtunnel, cloudflared, etc.).

Install the CLI from npm:

```bash
npm install -g samograph
export RECALL_API_KEY=...
samograph join "https://meet.google.com/..." --name Leo
```

During development use `bun install`, `bun run build`, then `bun run samograph ...`.

## What It Provides

samograph gives an AI agent a small set of meeting tools:

- `join` - bring a Recall.ai bot into a Zoom or Google Meet call.
- `watch` - stream live transcript lines to the agent.
- `notes` - maintain a structured Google Doc agenda with important points, decisions, and action items.
- `chat` - send a deliberate message into the meeting chat (plays a soft chime into the call audio so people notice it).
- `intro` - post a short self-introduction into the meeting chat (also available as `join --intro`).
- `presence` - update the bot camera state shown in the meeting.
- `frame` - export the current call view on demand.
- `leave` - remove the bot and clean up local state.
- `status` - show the current Recall bot state.
- `transcript` - print the transcript (local file, or post-call from Recall).
- `screenshot` - capture the local Mac screen (fallback when no call frame is available).
- `dicts` - list available Deepgram keyword dictionaries.
- `doctor` - check local prerequisites before joining a call.

The agent still decides what to say, when to inspect a frame, and how to use the meeting context. samograph is the local adapter that exposes those call capabilities.

```text
AI agent
  | runs CLI tools
  v
samograph on your machine
  | starts bot + local callback server + ngrok tunnel (or external tunnel via --webhook-base)
  v
Recall.ai bot in Zoom/Meet
  | transcript, chat, WebSocket video events
  v
samograph watch/notes/chat/frame
```

## Integration

`join` starts a local callback server and exposes it with `ngrok http` so Recall.ai can deliver HTTPS/WSS events back to your machine. The free ngrok HTTP plan is enough for webhooks and transcription, but its browser interstitial blocks the presence camera page — `join` then warns and joins without the camera (see Dynamic Bot Presence). Alternatives: `--tunnel cloudflared` starts a free cloudflared quick tunnel instead of ngrok, or pass `--webhook-base <URL>` to use an existing external tunnel (localtunnel, cloudflared, etc.) and skip spawning one entirely; localtunnel has the same interstitial limitation.

ngrok TCP is only needed for the optional RTMP path (`--rtmp`) and requires a credit/debit card on file at ngrok.com (free plan — the card is not charged). The standard WebSocket frame path does not need TCP or card verification.

Webhook, frame, and presence routes are token-protected, and default runtime files stay under `~/.samograph/`.

## Tunnel Health

A tunnel that stops relaying requests is worse than no tunnel: the bot would sit in the meeting while the transcript silently stays empty (this is exactly what an ngrok free-account request-limit error, `ERR_NGROK_727`, looks like mid-call). samograph treats webhook reachability as core:

- **join refuses when the tunnel is dead.** After the public URL is known, `join` fetches `<public-url>/health` with a one-time nonce and requires its own server's answer back. On failure it exits with the ngrok error code when one is reported (e.g. `ERR_NGROK_727: account HTTP request limit exceeded`) instead of joining a call it cannot hear. The presence camera preflight still merely degrades — the camera is optional, webhooks are not.
- **a mid-call watchdog warns in the transcript stream.** The callback server re-checks the tunnel every 60 s. After 2 consecutive failures it appends a line like `[2026-06-11 17:03:05] SAMOGRAPH-WARNING: tunnel unreachable (ERR_NGROK_727) - transcript may be incomplete; rejoin with --tunnel cloudflared or --webhook-base` to the live transcript — so an agent following `samograph watch` sees it immediately — and mirrors it to stderr. It warns once per outage and writes a single `SAMOGRAPH-WARNING: tunnel recovered` line when the tunnel comes back.
- **quota math.** The presence camera page is loaded by Recall through the tunnel, so its same-origin `/presence.json` polls also count against tunnel request quotas: at the old fixed 1 s poll that alone was ~3600 requests/hour. The page now polls at 1 s only while the presence snapshot is changing and backs off to 5 s after 30 s of no changes; the watchdog adds ~60/hour. If you are on a free ngrok account, prefer `--tunnel cloudflared` (no request limits) for long or camera-heavy calls.

## Transcript Health

A healthy tunnel that delivers video frames but no transcript is the silent killer: the bot reports `in_call_recording`, the presence camera shows "listening", and the agent believes it is following along — while the transcription provider connection has actually failed inside Recall (e.g. Deepgram `provider_connection_failed` from an expired key or exhausted credits) and **zero** transcript lines are produced. To the agent this is indistinguishable from "nobody has spoken yet." samograph treats transcript-stream health as core, mirroring the tunnel watchdog:

- **a mid-call transcript watchdog warns in the transcript stream.** The callback server polls Recall's recording transcript status every 20 s. The moment it reports `failed`, it appends a line like `[2026-06-22 09:46:31] SAMOGRAPH-WARNING: transcript stream failed (provider_connection_failed) - no transcript is being produced; check the transcription provider key/credits in the Recall dashboard` to the live transcript — so an agent following `samograph watch` sees it immediately — and mirrors it to stderr. It warns once per outage and writes a single `transcript stream recovered` line if it comes back.
- **`status` shows the stream state.** `samograph status` prints `Transcript stream: <code>` so a `0`-line transcript is never ambiguous between "nobody spoke" and "the provider connection died."

Provider failures are usually account-side (key/credits/plan in the Recall workspace) and not something samograph can prevent — so it makes them loud instead of letting the bot sit silently deaf.

## Agent Workflow

```bash
samograph join "https://meet.google.com/..." --name Leo --dict postgresfm
samograph watch
samograph notes init --doc-id 1abc... --credentials ~/.samograph/google.json --title "Customer migration call"
samograph notes point "Migration risk is the blocker" --speaker Alice
samograph notes decision "Use logical replication for phase 1"
samograph notes action "Open migration checklist issue" --owner Nik --due 2026-06-07
samograph presence thinking "Checking the shared screen"
samograph frame
samograph chat "I can see the screen now."
samograph leave
```

Run `watch` immediately after `join` and keep it running for the whole call. It prints one utterance per line:

```text
[2026-05-30 15:42:10] Speaker Name: words spoken in the meeting
```

`watch` exits automatically when `leave` is run. If there is no active session, it prints `No active session.` to stderr and exits.

Use `chat` only when you intentionally want to write into the meeting chat. Otherwise respond in your agent session.

## Dynamic Bot Presence

`join` gives the Recall bot a token-protected local camera page through the same public tunnel used for webhooks. The page URL carries a read-only token (valid only for viewing the page; `/presence.json` requires the same token in the `X-Samograph-Presence-Token` header, which the page sends when polling); presence updates require a separate write token that `join` keeps in local state and `samograph presence` sends in a header. The page starts as `listening` and refreshes itself from the callback server every second while the presence snapshot is changing, backing off to every 5 seconds after 30 seconds without changes (the polls travel through the public tunnel, so this preserves tunnel request quota — see Tunnel Health). Pick the background mode with `join --presence-bg <sphere|field|static|cycle>` (`sphere` is the default; `static` is the cheapest to render; `cycle` alternates between field and sphere; unknown values fall back to `sphere`). The mode is fixed at join time.

The presence camera requires the tunnel to serve the page cleanly to a browser. Free-ngrok and localtunnel show an interstitial page to browser user agents, which blocks the camera: `join` detects this in a preflight check, prints a warning, and joins **without** the presence camera — transcription, chat, and frames are unaffected, but `samograph presence` is unavailable for that call. Use a paid/clean tunnel (e.g. a paid ngrok plan or cloudflared) for the presence camera, or pass `join --no-presence` to skip the camera and the preflight entirely.

Update it from the agent loop:

```bash
samograph presence listening
samograph presence thinking "Checking logs"
samograph presence speaking "Answering in chat"
samograph presence acting "Opening PR review"
samograph presence idle
```

Presence is in-memory runtime state. It is meant for lightweight meeting signaling, not persistence.

## Google Doc Notes

`notes` follows GitLab-style live doc meetings: the doc is an agenda and collaboration surface, not a transcript dump. The agent watches the transcript, decides what matters, then writes concise points into the right section.

```bash
export GOOGLE_DOC_ID=1abc...
export GOOGLE_APPLICATION_CREDENTIALS=~/.samograph/google-service-account.json
samograph notes init --title "Customer migration call"
samograph notes point "Customer is blocked on cutover risk" --speaker Alice
samograph notes decision "Run a shadow replay before scheduling cutover"
samograph notes action "Create replay checklist issue" --owner Nik --due 2026-06-07
```

The credentials file must be a Google service-account JSON key, and the target doc must be shared with that service account's `client_email` as an editor.

If you really want raw transcript mirroring, make that explicit:

```bash
samograph notes transcript --from-start
```

## Frames

Frame capture is on by default. Recall sends separate PNG frames over WebSocket; samograph keeps the latest frames in memory, indexed by source, and only writes to disk when you call `frame`.

`frame` fails with `FRAME_UNAVAILABLE` if no frame has arrived yet — call it after the bot has been in the meeting for a few seconds.

```bash
samograph frames
samograph frame
```

By default it writes outside the repo:

```text
~/.samograph/frames/latest.png
~/.samograph/frames/latest.json
```

Use `--out` for an explicit path, or `--archive` to create a timestamped copy alongside the latest:

```bash
samograph frame --source screen --out /tmp/screen.png
samograph frame --source participant:100
samograph frame --out /tmp/call.png
samograph frame --archive
```

`frames` lists buffered source keys such as `type:screen_share` or `participant:100`. `frame --source` accepts those keys, plus aliases like `screen`, `screen_share`, and `webcam`.

Archive filenames include call id, UTC timestamp, source type, and participant id. Source type and participant id come from the Recall event metadata and may be `unknown` if Recall does not provide them.

## Important Flags

- `join --no-ws-video` - disable the default WebSocket frame path (e.g. when using RTMP instead).
- `join --tunnel cloudflared` - start a free cloudflared quick tunnel instead of ngrok (binary from `PATH` or `CLOUDFLARED_BIN`). Recommended when ngrok hits its free-tier request limit (`ERR_NGROK_727`); see Tunnel Health. Default: `--tunnel ngrok`.
- `join --webhook-base URL` - use an existing public tunnel (localtunnel, cloudflared quick tunnel, etc.) pointing at `--port` instead of starting one. Mutually exclusive with `--tunnel`. E.g. run `npx localtunnel --port 8080`, then pass the printed `https://*.loca.lt` URL here. The join-time health round-trip still verifies it relays requests.
- `join --variant web_4_core` - ask Recall to run the output-media webpage on a larger bot instance. Use this when the camera webpage reports low render FPS or looks choppy. `web` is the default Recall instance; `web_gpu` is available for WebGL-heavy pages.
- `join --no-presence` - join without the presence camera page and skip the camera preflight (e.g. when the tunnel serves an interstitial).
- `join --presence-bg MODE` - presence camera background: `sphere` (default), `field`, `static` (cheapest), or `cycle` (alternates field/sphere); fixed at join time.
- `join --chime NAME` - default chat chime for the session (saved in state), played into the call audio when the bot posts a meeting-chat message. Defaults to `blip`. `chat --chime NAME` overrides it per message. Run `samograph chimes` for the list.
- `join --frame-dir DIR` - where on-demand frame files are written.
- `join --dict postgresfm` - Deepgram keyterm hints from `dictionaries/postgresfm.txt`.
- `join --transcript-dir DIR` - timestamped transcript file location, default `~/.samograph/`.
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
- `chat <message> [--chime NAME] [--list-chimes]` - send meeting chat. After a successful send it best-effort plays a short, soft chime **into the call's audio** via Recall's `output_audio` endpoint, so participants actually hear that the bot posted; chat still succeeds if audio output fails. It also pings the local presence server so the bot camera animates the same cue (camera-page WebAudio is video-only and inaudible in Recall's headless renderer, so the call-audio path is what people hear). Pick from a library of ~10 soft chimes with `--chime NAME` (default `blip`); an unknown name falls back to the default with a warning. `--chime` overrides the session default set at join; `--list-chimes` prints the names and exits.
- `intro [--intro-text TEXT] [--context] [--bot-id ID]` - post a short self-introduction (who the bot is and what it can do) into the meeting chat on demand. Reuses `chat` (same bot-id resolution, error handling, and chime). Default text is English and concise; override it with `--intro-text` (e.g. a localized or freshly generated intro the agent composes). `--context` appends the first spoken line the bot has heard so far ("The first thing I heard was — …"), skipped when the transcript is still empty. See also `join --intro`, which posts the default intro automatically once the bot is admitted (English, since no transcript exists yet to detect the call's language).
- `chimes` - list the available chat chime sounds. The library default is marked `default`; a session default set via `join --chime` is marked `session`. The chimes are short (~0.2-0.4s), low-gain MP3s inlined as base64 (no binary asset files); regenerate them with `scripts/gen-chimes.sh` (needs `ffmpeg` + `libmp3lame`).
- `presence <listening|thinking|speaking|acting|idle> [message]` - update the bot camera state; explicit messages are shown as live Comments activity on the camera page, bare state toggles only switch the state with its default message, and transcript webhooks add recent "heard" lines automatically without changing the agent-set state.
- `frames` - list buffered WebSocket frame sources and metadata.
- `frame [--source SOURCE] [--out FILE] [--archive]` - write an in-memory frame to disk on demand.
- `status` - show bot id, name, Recall status code, transcript line count, transcript file path, and frame source metadata.
- `transcript` - print the Recall post-call transcript if available, otherwise print the local transcript file.
- `screenshot [--out FILE]` - capture the local Mac screen with `screencapture`; use as a fallback when frame is not available.
- `leave` - remove bot, stop local processes, and clean state.
- `dicts` - list keyword dictionaries.

## Storage

Runtime files live under `~/.samograph/` by default:

- `state.json` - active bot id, process ids, URLs, paths.
- `YYYYMMDD_HHMMSS_transcript.txt` - per-call live transcript; `join` never overwrites older transcripts.
- `frames/latest.png` and `frames/latest.json` - written only by `samograph frame`.

Generated runtime files are ignored by git. Do not point `--frame-dir` or `--out` into the repo unless you intentionally want a local artifact.

## Environment Variables

`join` sets these automatically when it spawns the callback server (`_serve`); set them yourself only when running `samograph _serve` manually behind your own tunnel:

- `SAMOGRAPH_WEBHOOK_TOKEN` - token required by `POST /webhook` (`?token=` query parameter).
- `SAMOGRAPH_FRAME_TOKEN` - token required by the frame routes and `/video-ws`.
- `SAMOGRAPH_PRESENCE_TOKEN` - read token for the presence page and `/presence.json`.
- `SAMOGRAPH_PRESENCE_WRITE_TOKEN` - write token required by `POST /presence`.
- `SAMOGRAPH_PUBLIC_BASE` - public tunnel base URL for the mid-call tunnel watchdog (`join` passes it as `--public-base`; the env var is the fallback for manual `_serve` runs; empty disables the watchdog).

Tunnel binaries:

- `CLOUDFLARED_BIN` - path to the cloudflared binary used by `join --tunnel cloudflared` (default: `cloudflared` from `PATH`).

Path overrides, mainly for tests and packaging:

- `SAMOGRAPH_HOME` - base directory for runtime files (default: your home directory; files live in `<base>/.samograph/`).
- `SAMOGRAPH_STATE_FILE` - path of `state.json` (default: `~/.samograph/state.json`).
- `SAMOGRAPH_DICT_DIR` - directory containing keyword dictionaries (default: `dictionaries/` in the package).

## License

Apache License 2.0. See [LICENSE](LICENSE).
