#!/usr/bin/env bash
# Record a REAL Claude Code session for the samocall demo.
#
# This captures an actual `claude` TUI with asciinema — real typing, real LLM
# streaming, real samocall output. No simulation. You drive the keyboard;
# follow demo/PROMPTS.md for the scripted turns.
#
#   ./demo/record-live.sh                 # → demo/samocall-live.cast
#   ./demo/record-live.sh my-take.cast    # custom output name
#
# After recording, turn the cast into a GIF:
#   ./demo/cast-to-gif.sh demo/samocall-live.cast
#
# Secret hygiene: RECALL_API_KEY must be set for the bot to join, but it is
# never printed by samocall or claude. DO NOT run `env`, `export`, or `echo
# $RECALL_API_KEY` while recording. The prompt sheet keeps the key off-screen.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="${1:-$SCRIPT_DIR/samocall-live.cast}"
case "$OUT" in /*) ;; *) OUT="$REPO_ROOT/$OUT" ;; esac

command -v asciinema >/dev/null 2>&1 || {
  echo "asciinema not installed. Install with: brew install asciinema" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || {
  echo "claude (Claude Code) not found on PATH." >&2; exit 1; }

if [ -z "${RECALL_API_KEY:-}" ]; then
  echo "warning: RECALL_API_KEY is not set — the bot will not be able to join." >&2
  echo "         set it before recording (it stays off-screen)." >&2
fi

rm -f "$OUT"

cat <<'TIPS'
─────────────────────────────────────────────────────────────────────
 Recording a REAL Claude Code session.

 • Follow demo/PROMPTS.md for the turns to type.
 • Type naturally — the recording captures your real keystrokes.
 • Have the Zoom call open with someone ready to speak.
 • When the scene is done, type `exit` (or Ctrl-D) to stop recording.
 • DO NOT print the token: no `env`, no `echo $RECALL_API_KEY`.
─────────────────────────────────────────────────────────────────────
TIPS
read -r -p "Press Enter to start recording…" _

# A clean, readable shell for the recording. asciinema records whatever runs
# inside; we launch claude directly so the cast is just the session.
asciinema rec "$OUT" \
  --idle-time-limit 3 \
  --title "samocall — put your AI agent in the meeting" \
  --command "claude"

echo
echo "Saved cast: $OUT"
echo "Next: ./demo/cast-to-gif.sh \"$OUT\""
