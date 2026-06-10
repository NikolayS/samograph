#!/usr/bin/env bash
# Append ONE transcript line to the file that the active `samocall watch` is
# tailing — used to inject scripted meeting dialogue during a manual recording.
#
# Unlike simulate-meeting.sh, this does NOT truncate the transcript and does NOT
# write state.json, so it is safe to run against a REAL `samocall join` session:
# the injected line appears to the watching agent exactly like a spoken utterance.
#
#   ./demo/say.sh Sofia "ok the orders page is crawling again"
#   ./demo/say.sh Marcus "yeah it's a seq scan on orders"
#
# It resolves the transcript file from the live state (SAMOCALL_STATE_FILE or
# ~/.samocall/state.json), falling back to ~/.samocall/transcript.txt.
set -euo pipefail

SPEAKER="${1:?usage: say.sh <speaker> <text...>}"; shift
TEXT="$*"
[ -n "$TEXT" ] || { echo "usage: say.sh <speaker> <text...>" >&2; exit 1; }

STATE="${SAMOCALL_STATE_FILE:-$HOME/.samocall/state.json}"
TF="$(awk -F'"' '/"transcript_file"/{print $4; exit}' "$STATE" 2>/dev/null || true)"
[ -n "$TF" ] || TF="$HOME/.samocall/transcript.txt"

ts="$(date '+%Y-%m-%d %H:%M:%S')"
printf '[%s] %s: %s\n' "$ts" "$SPEAKER" "$TEXT" >> "$TF"
echo "→ ${TF}: [$ts] $SPEAKER: $TEXT" >&2
