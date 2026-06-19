# samograph Agent Notes

Use samograph to join a meeting, watch the live transcript, speak in meeting chat when asked, and capture the call view on demand.

## API Key Setup

samograph needs a Recall.ai API key. **Never inline the key in shell commands** — it will appear in shell logs and AI conversation transcripts.

Store it once in the config file:

```bash
samograph config set recall-api-key <your-key>
```

samograph reads `~/.samograph/config.json` automatically on every invocation. The `RECALL_API_KEY` env var still takes precedence if set, but the config file means you never need to export it per session or pass it inline.

To verify the key is stored:

```bash
samograph config get recall-api-key
```

## Preferred Flow

```bash
samograph join "https://meet.google.com/..." --name Leo --dict postgresfm
samograph watch
samograph presence listening
samograph notes init --doc-id 1abc... --credentials ~/.samograph/google.json --title "Meeting live doc"
samograph frames
samograph frame
samograph leave
```

Start `watch` immediately after `join` with your persistent monitor. Keep it running until the call ends. Each line is:

```text
[timestamp] Speaker: utterance
```

React in your agent session. Use meeting chat only for deliberate call-visible messages:

```bash
samograph chat "Short message to the meeting"
```

## Tunnel Health Warnings

`join` refuses to start when the webhook tunnel does not relay requests (e.g. ngrok `ERR_NGROK_727`, the account request limit) — better than joining a call it cannot hear. Mid-call, a watchdog re-checks the tunnel every minute and writes warnings into the transcript stream you are watching:

```text
[timestamp] SAMOGRAPH-WARNING: tunnel unreachable (ERR_NGROK_727) - transcript may be incomplete; rejoin with --tunnel cloudflared or --webhook-base
```

If a `SAMOGRAPH-WARNING: tunnel unreachable` line appears in the transcript, tell the user immediately: live transcript delivery is broken and lines are being lost. Suggest leaving and rejoining with `--tunnel cloudflared` (free cloudflared quick tunnel, no request limits) or `--webhook-base` with their own tunnel. A later `SAMOGRAPH-WARNING: tunnel recovered` line means delivery resumed, but anything said during the outage is missing from the transcript.

## Dynamic Bot Presence

The bot camera shows a live presence page. Update it from the agent loop to signal what you are doing. Five states: `listening|thinking|speaking|acting|idle`.

```bash
samograph presence listening
samograph presence thinking "Checking logs"
samograph presence speaking "Answering in chat"
samograph presence acting "Opening PR review"
samograph presence idle
```

Presence is in-memory runtime state for lightweight in-call signaling, not persistent memory. Transcript lines appear on the camera page automatically as "heard" activity without changing the state you set. Bare state toggles (no message) switch the state with its default message and do not add a Comments entry; only explicit messages appear in the Comments lane.

## Live Google Doc Notes

Use `notes` when asked to keep a shared doc updated during the call:

```bash
samograph notes init --doc-id 1abc... --credentials ~/.samograph/google.json --title "Customer call"
samograph notes point "Customer is blocked on cutover risk" --speaker Alice
samograph notes decision "Run a shadow replay before scheduling cutover"
samograph notes action "Create replay checklist issue" --owner Nik --due 2026-06-07
```

The doc must already be shared with the service-account email as an editor. Do not dump the whole transcript into the doc unless asked; use `notes transcript --from-start` only for raw transcript mirroring. Prefer concise GitLab-style notes: agenda/question context, important points, decisions, action items, owners, dates, and links.

## Looking At The Call

Frame capture is on by default. Recall sends `video_separate_png.data` frames over the ngrok HTTPS/WSS tunnel. Frames stay in server memory, indexed by source; disk writes happen only when the agent calls:

```bash
samograph frames
samograph frame
```

Default output is outside the repo:

```text
~/.samograph/frames/latest.png
~/.samograph/frames/latest.json
```

Use explicit outputs only when needed:

```bash
samograph frame --source screen --out /tmp/screen.png
samograph frame --source participant:100
samograph frame --out /tmp/call.png
samograph frame --archive
```

`samograph frames` lists source keys such as `type:screen_share` and `participant:100`. `frame --source` accepts those keys, plus aliases like `screen`, `screen_share`, and `webcam`.

`--archive` creates a timestamped filename with bot id, source type, and participant id.

## Mixed Video

Use RTMP only when separate PNG frames are not enough:

```bash
samograph join "https://zoom.us/j/..." --rtmp
samograph join "https://zoom.us/j/..." --rtmp-url rtmp://HOST:1935/live/call
```

`--rtmp` needs ngrok TCP, which requires ngrok card verification. `--rtmp-url` needs a public RTMP receiver.

## End The Call

```bash
samograph leave
```

`leave` removes the bot, stops local helper processes, writes the `SAMOCALL_CALL_ENDED` sentinel, and lets `watch` exit cleanly.

## Merge Gate (samorev)

Every pull request must pass our review gate before it is merged. The gate is
[Tanya301/samorev](https://github.com/Tanya301/samorev) — a CLI-first code-review
tool. **Do not merge a PR unless both of the following are satisfied:**

1. **CI is green** — all CI/test checks pass (locally: `bun test` and
   `bunx tsc --noEmit` clean).
2. **samorev review passed and is posted as a PR comment** — run the gate and
   post its result to the PR. A merge is blocked if either check is missing,
   failing, or was forgotten.

```bash
# Deterministic gate (CI status + draft state) — posts a PASS/FAIL comment:
bun run samorev review https://github.com/<owner>/<repo>/pull/<n> --fetch
# Read-only (print to stdout, no posting):
bun run samorev review https://github.com/<owner>/<repo>/pull/<n> --no-comment --fetch
```

The Bun CLI gate checks CI status + draft state only. For real code analysis run
the `/review-mr` slash command (or spawn the samorev review agents — Security and
Bug Hunter are blocking), then post a comment with the combined result. Both
surfaces authenticate through `gh`/`glab`; see the repo's `docs/bot-operation.md`.
