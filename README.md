# samoagent

CLI meeting AI agent. Joins Zoom and Google Meet calls via [recall.ai](https://recall.ai), transcribes live speech (Russian+English mixed) using Deepgram Nova-3, and lets AI agents (Claude Code, OpenClaw, etc.) monitor the conversation and react — sending chat messages, capturing live video frames, and eventually speaking back.

## Requirements

- Python 3.9+
- `RECALL_API_KEY` env var (recall.ai account)
- `ngrok` installed and authenticated (free tier works)
- For RTMP frame capture: a cloud VM with a public IP (mediamtx is auto-downloaded on first use)

## Setup

```bash
pip install -r requirements.txt
export RECALL_API_KEY=your_key
```

## Quick start

```bash
# Join a call
python3 samoagent join "https://zoom.us/j/123456789" --name TARS --dict postgresfm

# Stream the live transcript (run this immediately after joining)
python3 samoagent watch

# Capture a frame from the call (requires --rtmp-url; see Frame capture below)
python3 samoagent frame

# Leave when done
python3 samoagent leave
```

The bot appears in the call within ~15 seconds of `join`.

## Commands

| Command | Description |
|---|---|
| `join <url>` | Join a call. Starts ngrok + local webhook server, creates recall.ai bot. |
| `watch` | Stream live transcript lines to stdout (`[timestamp] Speaker: text`). |
| `chat <message>` | Send a message into the meeting chat. |
| `frame` | Capture a frame from the live call video (requires `--rtmp-url`). Prints `FRAME_UNAVAILABLE` if RTMP not configured. |
| `screenshot` | Capture the local Mac screen via `screencapture` (last resort). |
| `status` | Show current bot status from recall.ai. |
| `transcript` | Fetch the full post-call transcript from recall.ai. |
| `leave` | Remove bot from call, kill ngrok and webhook server, clean up state. |
| `dicts` | List available keyword dictionaries. |

**Key flags for `join`:**

- `--name TARS` — bot display name shown in the call (appended with " 🔴 (samoagent)")
- `--dict postgresfm` — load a keyword dictionary from `dictionaries/` for Deepgram transcription accuracy
- `--rtmp-url rtmp://PUBLIC_IP:1935/live/call` — enable live frame capture via RTMP (requires cloud VM)
- `--transcript-dir /path/to/dir` — where to write `transcript.txt` (default: `~/.samoagent/`)
- `--port 8080` — local webhook port (default: 8080)

## Architecture

1. `samoagent join` starts a local Flask webhook server and an ngrok tunnel, then creates a recall.ai bot with that webhook URL.
2. The recall.ai bot joins the call. Deepgram Nova-3 transcribes audio in real time (multilingual: Russian + English).
3. Transcript words stream to the webhook → appended to `~/.samoagent/transcript.txt`.
4. `samoagent watch` tails that file and prints new lines to stdout.
5. For frame capture: recall.ai streams the mixed call video as FLV over RTMP to `--rtmp-url`. A local mediamtx server receives it. `samoagent frame` runs ffmpeg against the local stream and saves a PNG.

State (bot ID, PIDs, paths) lives in `~/.samoagent/state.json`. All stateful commands (`watch`, `leave`, `status`, etc.) read it automatically.

## Frame capture

`samoagent frame` requires a cloud VM with a public IP:

```bash
# On the VM: mediamtx is auto-downloaded on first use
# Join with RTMP URL pointing to your VM
python3 samoagent join "https://zoom.us/j/..." --rtmp-url rtmp://YOUR_VM_IP:1935/live/call
```

Without `--rtmp-url`, `samoagent frame` prints `FRAME_UNAVAILABLE`. On macOS without a cloud VM, use `samoagent screenshot` (local screen capture) or browser tools to capture the Meet/Zoom tab.

## Dictionaries

Place `.txt` files in `dictionaries/` with one term per line (max 100 terms). These are sent to Deepgram as keyterm hints to improve transcription of domain-specific vocabulary. Run `samoagent dicts` to see what's available.

## For AI agents

**Read `CLAUDE.md` first.** It contains the full agent workflow with exact commands, Monitor tool instructions, and how to interpret transcript output.

Short version:
1. Run `samoagent join` → read the **AGENT INSTRUCTIONS** block it prints.
2. Immediately start `samoagent watch` via your Monitor tool (`persistent=true`). Each line: `[timestamp] Speaker: utterance`.
3. React to what is said in your agent session output (not meeting chat, unless explicitly asked).
4. Use `samoagent frame` on demand when asked to look at the screen.
5. Run `samoagent leave` when done.

## Files

```
samoagent          — main CLI executable
dictionaries/      — Deepgram keyterm hint files (.txt, one term per line)
specs/             — feature specs (voice output, etc.)
avatar.html        — bot video feed (robot avatar with animated recording dot)
avatar.png         — static avatar image
```

Runtime state and transcripts are written to `~/.samoagent/` (never in the repo).
