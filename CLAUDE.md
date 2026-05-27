# samoagent

CLI meeting AI agent. Joins Zoom/Google Meet calls via recall.ai, transcribes live using Deepgram (Russian+English mixed), and provides screenshots on demand.

## Setup

Requirements: `RECALL_API_KEY` env var, `ngrok` installed and authenticated, Python 3.9+.

```
pip install -r requirements.txt
export RECALL_API_KEY=your_key
```

## Agent workflow (read this first)

When you join a call with `samoagent join`, the output will include an **AGENT INSTRUCTIONS** block. Follow it exactly:

1. **Join** the call — the bot appears in ~15 seconds
2. **Start monitoring** the live transcript immediately using your Monitor tool (persistent=true):
   ```
   python3 samoagent watch
   ```
   Each line you receive: `[timestamp] Speaker: utterance`
3. **React** to what is said — if someone addresses you or asks a question, respond in chat
4. **Take a screenshot** on demand when someone says to look at something:
   ```
   python3 samoagent screenshot
   ```
   Then use the Read tool on `screenshot.png` to analyze what's on screen
5. **Leave** when told:
   ```
   python3 samoagent leave
   ```

Keep the monitor running for the entire duration of the call. Do not stop it unless explicitly asked.

## Commands

### Join a call
```
python3 samoagent join "https://zoom.us/j/123456" --name TARS --dict postgresfm
```
- `--name` sets bot display name: "TARS 🔴 (samoagent)"
- `--dict` loads keyword dictionary from `dictionaries/` for Deepgram transcription accuracy
- `--port` sets local webhook port (default 8080)
- `--transcript-dir` sets where transcript.txt is written (default: ~/.samoagent/)
- Starts ngrok tunnel + local Flask webhook server automatically
- Bot appears in call within ~15 seconds

### Watch live transcript (stream to stdout)
```
python3 samoagent watch
```
Streams transcript lines as they arrive. Use this with your Monitor tool (persistent=true) to follow the call in real time.

### Check status
```
python3 samoagent status
```

### Read full transcript (post-call, from recall.ai)
```
python3 samoagent transcript
```

### Take a screenshot
```
python3 samoagent screenshot --out screenshot.png
```
Captures full screen using macOS `screencapture`. Read the resulting file with the Read tool (it supports images) to analyze what is currently shown on screen during the call.

### Leave the call
```
python3 samoagent leave
```
Removes bot from call, kills ngrok and webhook server, cleans up state.

### List dictionaries
```
python3 samoagent dicts
```

## State management

Active bot state is stored in `~/.samoagent/state.json`. Contains bot_id, PIDs for server/ngrok, webhook URL, transcript file path. Cleaned up on `leave`. Commands like `status`, `leave`, `transcript`, `watch` use it automatically — no need to pass bot_id.

Transcript is written to `~/.samoagent/transcript.txt` by default (never in the repo directory).

## Dictionaries

Place `.txt` files in `dictionaries/` with one term per line (max 100 terms). These are sent to Deepgram as keyword hints to improve transcription of domain-specific terms. Available: `postgresfm` (PostgreSQL terminology).

## Example session

```
# Join a postgres.ai team call
python3 samoagent join "https://zoom.us/j/123456789" --name TARS --dict postgresfm

# IMMEDIATELY after join — start monitoring (use Monitor tool, persistent=true):
python3 samoagent watch

# On demand — take a screenshot and analyze it
python3 samoagent screenshot
# Read tool: Read screenshot.png

# Check bot status
python3 samoagent status

# When done
python3 samoagent leave
```

## Files

- `samoagent` — main executable script
- `dictionaries/` — keyword dictionaries for Deepgram
- `avatar.html` / `avatar.png` — bot video feed (elephant + animated recording dot)
- `~/.samoagent/transcript.txt` — live transcript (outside repo, never committed)
- `~/.samoagent/state.json` — runtime state (outside repo, never committed)
