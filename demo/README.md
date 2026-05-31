# samoagent demos

Terminal recordings of **real** Claude Code sessions using samoagent — actual
typing, actual LLM streaming, actual `samoagent` output joining a live call.

We record the real thing (not a simulation) so the demo is honest about what the
experience looks like.

## Files

- `record-live.sh` — record a real Claude Code session with asciinema
- `cast-to-gif.sh` — convert the `.cast` to an optimized GIF (via `agg`)
- `PROMPTS.md` — the scripted turns to type during a recording
- `cleanup.sh` — remove generated casts/GIFs

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
