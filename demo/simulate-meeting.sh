#!/usr/bin/env bash
# Simulate a live meeting by writing transcript lines to the file that
# `samoagent watch` tails. No Zoom, no recall.ai, no secrets — deterministic and
# safe to record. A REAL `samoagent watch` (and a real Claude Code session
# reading it) sees the meeting unfold exactly as if a bot were in the call.
#
#   # 1. point samoagent at a throwaway state + transcript:
#   export SAMOAGENT_STATE_FILE=/tmp/samoagent-demo/state.json
#
#   # 2. start the simulator (writes the scene to the watched file on a timer):
#   ./demo/simulate-meeting.sh demo/scenes/slow-query.txt
#
#   # 3. in the recorded session, run the real watcher:
#   samoagent watch
#
# Scene format (see demo/scenes/*.txt): "<gap_seconds> | Speaker | text".
set -euo pipefail

SCENE="${1:-demo/scenes/slow-query.txt}"
[ -f "$SCENE" ] || { echo "scene not found: $SCENE" >&2; exit 1; }

STATE_FILE="${SAMOAGENT_STATE_FILE:-/tmp/samoagent-demo/state.json}"
TRANSCRIPT="${SAMOAGENT_DEMO_TRANSCRIPT:-/tmp/samoagent-demo/transcript.txt}"
SPEED="${DEMO_SPEED:-1.0}"            # scales every gap; 0 = no waiting
CLOCK="${DEMO_CLOCK:-15:42:00}"       # starting wall-clock shown in lines

mkdir -p "$(dirname "$STATE_FILE")" "$(dirname "$TRANSCRIPT")"
: > "$TRANSCRIPT"
# Minimal state so `samoagent watch` treats this as an active session.
cat > "$STATE_FILE" <<JSON
{ "bot_id": "demo", "transcript_file": "$TRANSCRIPT" }
JSON

# advance HH:MM:SS by N seconds (portable, no GNU date)
tick() {
  local base="$1" add="$2" h m s total
  IFS=: read -r h m s <<<"$base"
  total=$(( (10#$h*3600 + 10#$m*60 + 10#$s + add) % 86400 ))
  printf '%02d:%02d:%02d' $((total/3600)) $((total%3600/60)) $((total%60))
}

elapsed=0
while IFS= read -r raw || [ -n "$raw" ]; do
  line="${raw%%$'\r'}"
  case "$line" in ''|\#*) continue ;; esac
  gap="$(printf '%s' "$line" | cut -d'|' -f1 | tr -d ' ')"
  who="$(printf '%s' "$line" | cut -d'|' -f2 | sed 's/^ *//;s/ *$//')"
  text="$(printf '%s' "$line" | cut -d'|' -f3- | sed 's/^ *//')"
  if [ "$SPEED" != "0" ]; then
    sleep "$(awk -v g="$gap" -v sp="$SPEED" 'BEGIN{printf "%.2f", g*sp}')"
  fi
  elapsed=$(( elapsed + gap ))
  ts="$(tick "$CLOCK" "$elapsed")"
  printf '[%s] %s: %s\n' "$ts" "$who" "$text" >> "$TRANSCRIPT"
done < "$SCENE"

# Let the watcher flush the last line before the call "ends".
[ "$SPEED" != "0" ] && sleep 1
printf '[%s] SAMOAGENT_CALL_ENDED\n' "$(tick "$CLOCK" $((elapsed+2)))" >> "$TRANSCRIPT"
echo "scene complete → $TRANSCRIPT" >&2
