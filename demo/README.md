# samoagent demos

Terminal recordings of **real** Claude Code sessions using samoagent — actual
typing, actual LLM streaming, actual `samoagent` output joining a call.

The published GIF is **recorded manually**: a human drives a real Claude Code
session, while the meeting dialogue is injected into the transcript with
`say.sh` so the scene is short, scripted, and repeatable. It is not generated in
CI — recording an LLM session is inherently non-deterministic, so we record by
hand and keep the result in the repo.

## Files

- `say.sh` — inject ONE transcript line into the live session (the scripted
  "teammates"). Append-only; safe to run against a real `samoagent join`.
- `scenes/*.txt` — scripted meeting dialogue (`<gap> | Speaker | text`).
- `simulate-meeting.sh` — replay a whole scene into a *throwaway* transcript
  (truncates + writes its own state) — for previewing a scene WITHOUT a real
  call. Do not use it against a live join; use `say.sh` for that.
- `record-tmux.sh` / `record-live.sh` — start a recorded `claude` session.
- `cast-to-gif.sh` — convert the `.cast` to an optimized GIF (via `agg`).
- `PROMPTS.md` — the prompt sheet for the human driver.
- `cleanup.sh` — remove generated casts/GIFs.

## Manual recording runbook

This is the procedure used for the published GIF. It needs two people (or one
person + an assistant running the bash side):

- **Driver** types prompts to a real Claude Code session running inside
  `asciinema` (so the pane is recorded).
- **Injector** runs `say.sh` lines in another shell to play the "teammates",
  timed to the agent's reactions.

> ⚠️ The meeting URL is visible in the recording. Use a **disposable** meeting
> (end it after recording) so the published GIF doesn't expose a reusable room.
> `RECALL_API_KEY` stays off-screen — never `echo` it or run `env`.

```bash
# Driver — start a recorded claude session (or wrap your existing tmux pane):
asciinema rec demo/samoagent-live.cast --overwrite --idle-time-limit 2.5 --command claude
```

**1. Driver → Claude** (one short prompt):

```
join my Zoom call with samoagent (--name Leo) and watch the transcript.
if you spot a DB performance problem, post one short line to the meeting chat,
then verify it on a DBLab branch and open a PR with before/after plans.
keep your messages short.   Zoom: <YOUR_DISPOSABLE_ZOOM_URL>
```

Wait until the agent has joined and `samoagent watch` is streaming (state.json
exists).

**2. Injector → bash** (play the teammates, ~3 s apart, watching the agent):

```bash
./demo/say.sh Sofia  "orders page is crawling again"
./demo/say.sh Marcus "it's a seq scan on orders"
./demo/say.sh Sofia  "but we index created_at"
./demo/say.sh Marcus "filter's on status though, not created_at"
./demo/say.sh Sofia  "Leo, can you take a look?"
```

The agent should diagnose the missing composite index, `samoagent chat` a short
suggestion, and offer to verify on a DBLab branch + open a PR.

**3. Driver → Claude** (wrap up):

```
leave the call
```

Then stop the recording (`/exit` in Claude, or Ctrl-D) and render:

```bash
./demo/cast-to-gif.sh demo/samoagent-live.cast   # → demo/samoagent-live.gif
```

Review the GIF before committing. Casts/GIFs are gitignored by default; commit
the final GIF explicitly when you're happy with it.

## Preview a scene without a call

```bash
SAMOAGENT_STATE_FILE=/tmp/sa/state.json \
SAMOAGENT_DEMO_TRANSCRIPT=/tmp/sa/t.txt \
DEMO_SPEED=1.0 ./demo/simulate-meeting.sh demo/scenes/slow-query.txt &
SAMOAGENT_STATE_FILE=/tmp/sa/state.json bun src/cli.ts watch
```
