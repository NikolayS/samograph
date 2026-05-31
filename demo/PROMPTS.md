# Demo recording — prompt sheet

The scripted turns for the samoagent demo. Type these into a **real** Claude
Code session (started by `./demo/record-live.sh`). Type naturally; the recording
captures your real keystrokes and Claude's real responses.

Have the Zoom call open in another window with a teammate ready to say a line or
two once the bot joins.

> **Secret hygiene:** `RECALL_API_KEY` must already be set in your shell before
> recording. Never type `env`, `export`, or `echo $RECALL_API_KEY` on camera.

## Turns

1. **The ask** (paste as one message):

   ```
   the team is discussing a refactor on this codebase right now — join us on
   Zoom and follow along. use samoagent (https://samoagent.dev)
   ```

   Claude should install it (`npm install -g samoagent`) and explain it needs a
   recall.ai key.

2. **The token** (already set — just tell it):

   ```
   RECALL_API_KEY is already set in my environment
   ```

3. **Join the call** (use the live link):

   ```
   join https://us02web.zoom.us/j/<MEETING_ID>?pwd=<PWD> and start watching the
   transcript — react in here, don't message the call unless I say so
   ```

   Claude runs `samoagent join … --dict postgresfm`, then `samoagent watch`.

4. **A teammate speaks in Zoom** (real audio). Something the agent can act on,
   e.g. a slow-query/refactor topic. Let the transcript stream in and Claude
   react in the session.

5. **Optional — ask it to chime in:**

   ```
   go ahead and share that suggestion in the meeting chat
   ```

6. **Wrap up:**

   ```
   leave the call
   ```

   Then type `exit` (or Ctrl-D) to stop the asciinema recording.

## After recording

```bash
./demo/cast-to-gif.sh demo/samoagent-live.cast
```

Review the GIF before committing. Keep it under ~2 MB (the script runs gifsicle).
