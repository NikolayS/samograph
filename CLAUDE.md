# samoagent

CLI meeting AI agent. Joins Zoom/Google Meet calls via recall.ai, transcribes live using Deepgram (Russian+English mixed), and provides screenshots on demand.

## Setup

Requirements: `RECALL_API_KEY` env var, `ngrok` installed and authenticated, Python 3.9+.

```
pip install -r requirements.txt
export RECALL_API_KEY=your_key
```

## Commands

### Join a call
```
python3 samoagent join "https://zoom.us/j/123456" --name TARS --dict postgresfm
```
- `--name` sets bot display name: "TARS 🔴 (samoagent)"
- `--dict` loads keyword dictionary from `dictionaries/` for Deepgram transcription accuracy
- `--port` sets local webhook port (default 8080)
- Starts ngrok tunnel + local Flask webhook server automatically
- Bot appears in call within ~15 seconds

### Check status
```
python3 samoagent status
```

### Read transcript
```
cat transcript.txt
```
The transcript file is appended in real time. Each line: `[timestamp] Speaker: text`. Read it directly with `cat` or the Read tool. For the full post-call transcript from recall.ai:
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

Active bot state is stored in `.samoagent.json` (gitignored). Contains bot_id, PIDs for server/ngrok, webhook URL. Cleaned up on `leave`. If state file exists, commands like `status`, `leave`, `transcript` use it automatically -- no need to pass bot_id.

## Dictionaries

Place `.txt` files in `dictionaries/` with one term per line (max 100 terms). These are sent to Deepgram as keyword hints to improve transcription of domain-specific terms. Available: `postgresfm` (PostgreSQL terminology).

## Example session

```
# Join a postgres.ai team call
python3 samoagent join "https://zoom.us/j/123456789" --name "pgai agent" --dict postgresfm

# Monitor transcript as it grows
cat transcript.txt

# Take a screenshot to see what's on screen
python3 samoagent screenshot
# Then use the Read tool on screenshot.png to analyze it

# Check bot status
python3 samoagent status

# When done
python3 samoagent leave
```

## Files

- `samoagent` -- main executable script
- `dictionaries/` -- keyword dictionaries for Deepgram
- `transcript.txt` -- live transcript output (gitignored)
- `.samoagent.json` -- runtime state (gitignored)
- `logo.svg` -- bot avatar shown in calls
