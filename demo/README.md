# samoagent demos

Terminal recordings of **real** Claude Code sessions using samoagent — actual
typing, actual LLM streaming, actual `samoagent` output joining a live call.

We record the real thing (not a simulation) so the demo is honest about what the
experience looks like.

## Files

- `record-tmux.sh` — drive a real Claude Code TUI inside tmux, recorded by
  asciinema. Scriptable: send each turn with natural typing, sync with a live
  call. **Preferred** — an orchestrator (or an outer agent) can run the whole
  take hands-free.
- `record-live.sh` — record a real Claude Code session you type by hand
  (no tmux; you drive the keyboard).
- `cast-to-gif.sh` — convert the `.cast` to an optimized GIF (via `agg`)
- `PROMPTS.md` — the scripted turns to send during a recording
- `cleanup.sh` — remove generated casts/GIFs

## Record via tmux (scriptable)

```bash
export RECALL_API_KEY=…            # off-screen, inherited by the session

./demo/record-tmux.sh start        # boots tmux + asciinema + real claude
sleep 8                            # let claude finish booting

./demo/record-tmux.sh type "the team is discussing a refactor right now — join us on Zoom and follow along, use samoagent (samoagent.dev)"
./demo/record-tmux.sh wait "installed|samoagent"      # watch it install
./demo/record-tmux.sh type "RECALL_API_KEY is already set in my environment"
./demo/record-tmux.sh type "join https://us02web.zoom.us/j/<ID>?pwd=<PWD> and watch the transcript"
./demo/record-tmux.sh wait "watch|transcript"

# ── a teammate speaks in the Zoom call; let the transcript stream + claude react ──
./demo/record-tmux.sh peek         # check progress any time

./demo/record-tmux.sh type "leave the call"
./demo/record-tmux.sh stop         # finalizes demo/samoagent-live.cast

./demo/cast-to-gif.sh demo/samoagent-live.cast
```

The pane is the recorded PTY, so the GIF is exactly the real `claude` session —
real typing rhythm, real streaming, real samoagent output.

## How to record

```bash
# 1. Make sure your recall.ai key is set (stays off-screen during recording)
export RECALL_API_KEY=…

# 2. Open the Zoom call, with a teammate ready to speak a line or two.

# 3. Record — this launches a real `claude` session inside asciinema:
./demo/record-live.sh            # → demo/samoagent-live.cast

# 4. Follow demo/PROMPTS.md for the turns. Type `exit` when done.

# 5. Render to GIF:
./demo/cast-to-gif.sh demo/samoagent-live.cast   # → demo/samoagent-live.gif
```

Requirements: `asciinema` and `agg` (`brew install asciinema agg`), `gifsicle`
for optimization (`brew install gifsicle`), and `claude` (Claude Code) on PATH.

## Pacing

`agg`'s `--idle-time-limit 1.5` trims dead air (long thinking pauses) without
touching the natural rhythm of typing and streaming. Use `AGG_SPEED=1.2
./demo/cast-to-gif.sh …` to gently speed up if a take runs long.

## Conventions

- Keep GIFs under ~2 MB for README embedding (cast-to-gif.sh runs
  `gifsicle -O3 --lossy=80 --colors 128`).
- **Never** print secrets on camera: no `env`, no `echo $RECALL_API_KEY`. Use a
  password-protected Zoom link and avoid showing the password where possible.
- Review every recording before committing.
