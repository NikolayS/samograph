#!/usr/bin/env bash
# Convert an asciinema cast of a real Claude Code session into an optimized GIF.
#
#   ./demo/cast-to-gif.sh demo/samograph-live.cast        # → same name .gif
#   ./demo/cast-to-gif.sh demo/samograph-live.cast out.gif
#
# Pacing: --idle-time-limit caps dead air so long thinking pauses don't bloat
# the GIF, while real typing and streaming keep their natural rhythm. Tune
# AGG_SPEED (default 1.0) to gently speed up or slow down playback.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAST="${1:?usage: cast-to-gif.sh <input.cast> [output.gif]}"
GIF="${2:-${CAST%.cast}.gif}"
AGG_SPEED="${AGG_SPEED:-1.0}"

command -v agg >/dev/null 2>&1 || {
  echo "agg not installed. Install with: brew install agg" >&2; exit 1; }
[ -f "$CAST" ] || { echo "cast not found: $CAST" >&2; exit 1; }

echo "Rendering $CAST → $GIF (speed ${AGG_SPEED}x) ..."
agg \
  --theme dracula \
  --font-size 16 \
  --line-height 1.4 \
  --idle-time-limit 1.5 \
  --speed "$AGG_SPEED" \
  "$CAST" "$GIF"

before="$(du -h "$GIF" | cut -f1)"
if command -v gifsicle >/dev/null 2>&1; then
  gifsicle -O3 --lossy=80 --colors 128 "$GIF" -o "$GIF.opt" && mv "$GIF.opt" "$GIF"
  echo "Optimized: $before → $(du -h "$GIF" | cut -f1)"
else
  echo "gifsicle not found — skipping optimization (size: $before)"
fi
echo "Done: $GIF"
