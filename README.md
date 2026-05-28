# samoagent

CLI meeting AI agent. Joins Zoom and Google Meet calls via [recall.ai](https://recall.ai), transcribes live speech using Deepgram Nova-3, and lets AI agents (Claude Code, OpenClaw, etc.) monitor the conversation and react — sending chat messages, capturing live video frames, and eventually speaking back.

## Requirements

- Python 3.9+
- `RECALL_API_KEY` env var (recall.ai account)
- `ngrok` installed and authenticated (free tier works for HTTP webhooks)
- For RTMP frame capture via `--rtmp`: ngrok free tier with a credit/debit card on file at [ngrok.com](https://dashboard.ngrok.com/settings#id-verification) (card is NOT charged — required by ngrok to enable TCP tunnels on free accounts). No cloud VM needed.
- For RTMP frame capture via `--rtmp-url`: a cloud VM with a public IP (mediamtx is auto-downloaded on first use)

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
- `--rtmp` — enable live frame capture via RTMP **without a cloud VM**: auto-starts mediamtx locally and opens a ngrok TCP tunnel so recall.ai can stream the call video back to this machine. Requires a credit/debit card on file at ngrok.com (free plan — card is NOT charged). See [ngrok identity verification](https://dashboard.ngrok.com/settings#id-verification).
- `--rtmp-url rtmp://PUBLIC_IP:1935/live/call` — enable live frame capture via RTMP with an explicit public URL (cloud VM with mediamtx, or `localhost` if running on the VM itself)
- `--transcript-dir /path/to/dir` — where to write `transcript.txt` (default: `~/.samoagent/`)
- `--port 8080` — local webhook port (default: 8080)

## Architecture

1. `samoagent join` starts a local Flask webhook server and an ngrok tunnel, then creates a recall.ai bot with that webhook URL.
2. The recall.ai bot joins the call. Deepgram Nova-3 transcribes audio in real time (multilingual).
3. Transcript words stream to the webhook → appended to `~/.samoagent/transcript.txt`.
4. `samoagent watch` tails that file and prints new lines to stdout.
5. For frame capture: recall.ai streams the mixed call video as FLV over RTMP to `--rtmp-url`. A local mediamtx server receives it. `samoagent frame` runs ffmpeg against the local stream and saves a PNG.

State (bot ID, PIDs, paths) lives in `~/.samoagent/state.json`. All stateful commands (`watch`, `leave`, `status`, etc.) read it automatically.

## Frame capture

There are two ways to enable `samoagent frame` (live frame capture from inside the call):

### Option A: `--rtmp` — no cloud VM needed (recommended for local use)

```bash
python3 samoagent join "https://zoom.us/j/..." --rtmp
```

This automatically:
1. Downloads and starts mediamtx locally on port 1935
2. Opens a ngrok TCP tunnel so recall.ai can reach your local machine
3. Passes the ngrok public RTMP URL to recall.ai

**Requirement:** A credit/debit card must be on file at [ngrok.com](https://dashboard.ngrok.com/settings#id-verification) (free plan — the card is NOT charged). ngrok requires this to enable TCP tunnels on free accounts (to prevent abuse). If no card is on file, `join --rtmp` prints a clear error with the link to add one.

### Option B: `--rtmp-url` — cloud VM with public IP

```bash
# mediamtx is auto-downloaded on the VM on first use
python3 samoagent join "https://zoom.us/j/..." --rtmp-url rtmp://YOUR_VM_IP:1935/live/call
```

### Without RTMP

`samoagent frame` prints `FRAME_UNAVAILABLE`. Alternatives:
- `samoagent screenshot` — captures the local Mac screen (last resort, macOS only)
- Browser tools — screenshot the Meet/Zoom tab directly

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
