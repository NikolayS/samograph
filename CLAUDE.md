# samoagent Agent Notes

Use samoagent to join a meeting, watch the live transcript, speak in meeting chat when asked, and capture the call view on demand.

## Preferred Flow

```bash
samoagent join "https://meet.google.com/..." --name Leo --dict postgresfm
samoagent watch
samoagent notes init --doc-id 1abc... --credentials ~/.samoagent/google.json --title "Meeting live doc"
samoagent frames
samoagent frame
samoagent leave
```

Start `watch` immediately after `join` with your persistent monitor. Keep it running until the call ends. Each line is:

```text
[timestamp] Speaker: utterance
```

React in your agent session. Use meeting chat only for deliberate call-visible messages:

```bash
samoagent chat "Short message to the meeting"
```

## Dynamic Bot Presence

The bot camera shows a live presence page. Update it from the agent loop to signal what you are doing. Five states: `listening|thinking|speaking|acting|idle`.

```bash
samoagent presence listening
samoagent presence thinking "Checking logs"
samoagent presence speaking "Answering in chat"
samoagent presence acting "Opening PR review"
samoagent presence idle
```

Presence is in-memory runtime state for lightweight in-call signaling, not persistent memory. Transcript lines appear on the camera page automatically as "heard" activity without changing the state you set.

## Live Google Doc Notes

Use `notes` when asked to keep a shared doc updated during the call:

```bash
samoagent notes init --doc-id 1abc... --credentials ~/.samoagent/google.json --title "Customer call"
samoagent notes point "Customer is blocked on cutover risk" --speaker Alice
samoagent notes decision "Run a shadow replay before scheduling cutover"
samoagent notes action "Create replay checklist issue" --owner Nik --due 2026-06-07
```

The doc must already be shared with the service-account email as an editor. Do not dump the whole transcript into the doc unless asked; use `notes transcript --from-start` only for raw transcript mirroring. Prefer concise GitLab-style notes: agenda/question context, important points, decisions, action items, owners, dates, and links.

## Looking At The Call

Frame capture is on by default. Recall sends `video_separate_png.data` frames over the ngrok HTTPS/WSS tunnel. Frames stay in server memory, indexed by source; disk writes happen only when the agent calls:

```bash
samoagent frames
samoagent frame
```

Default output is outside the repo:

```text
~/.samoagent/frames/latest.png
~/.samoagent/frames/latest.json
```

Use explicit outputs only when needed:

```bash
samoagent frame --source screen --out /tmp/screen.png
samoagent frame --source participant:100
samoagent frame --out /tmp/call.png
samoagent frame --archive
```

`samoagent frames` lists source keys such as `type:screen_share` and `participant:100`. `frame --source` accepts those keys, plus aliases like `screen`, `screen_share`, and `webcam`.

`--archive` creates a timestamped filename with bot id, source type, and participant id.

## Mixed Video

Use RTMP only when separate PNG frames are not enough:

```bash
samoagent join "https://zoom.us/j/..." --rtmp
samoagent join "https://zoom.us/j/..." --rtmp-url rtmp://HOST:1935/live/call
```

`--rtmp` needs ngrok TCP, which requires ngrok card verification. `--rtmp-url` needs a public RTMP receiver.

## End The Call

```bash
samoagent leave
```

`leave` removes the bot, stops local helper processes, writes the `SAMOAGENT_CALL_ENDED` sentinel, and lets `watch` exit cleanly.
