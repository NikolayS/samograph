# samoagent Agent Notes

Use samoagent to join a meeting, watch the live transcript, speak in meeting chat when asked, and capture the call view on demand.

## Preferred Flow

```bash
samoagent join "https://meet.google.com/..." --name Leo --dict postgresfm
samoagent watch
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

## Looking At The Call

Frame capture is on by default. Recall sends `video_separate_png.data` frames over the ngrok HTTPS/WSS tunnel. Frames stay in server memory; disk writes happen only when the agent calls:

```bash
samoagent frame
```

Default output is outside the repo:

```text
~/.samoagent/frames/latest.png
~/.samoagent/frames/latest.json
```

Use explicit outputs only when needed:

```bash
samoagent frame --out /tmp/call.png
samoagent frame --archive
```

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
