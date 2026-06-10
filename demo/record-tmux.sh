#!/usr/bin/env bash
# Drive a REAL Claude Code TUI inside tmux, recorded by asciinema.
#
# This is the scriptable path: an orchestrator (you, or an outer agent) sends
# each turn with natural, character-by-character typing, while a *real* `claude`
# session runs samocall for real. Nothing is simulated.
#
# Subcommands (run as separate steps so you can sync with a live call):
#   ./demo/record-tmux.sh start        # boot tmux + asciinema + claude
#   ./demo/record-tmux.sh type "text"  # type a line at human speed, then Enter
#   ./demo/record-tmux.sh send "text"  # type without pressing Enter
#   ./demo/record-tmux.sh key Enter    # send a raw key (Enter, C-d, Escape, …)
#   ./demo/record-tmux.sh peek         # print the current pane (to watch progress)
#   ./demo/record-tmux.sh wait "regex" # block until the pane matches regex
#   ./demo/record-tmux.sh stop         # exit claude, finalize the .cast
#
# Env:
#   SESSION  tmux session name      (default: samocall-demo)
#   CAST     output cast path       (default: demo/samocall-live.cast)
#   COLS×ROWS terminal size         (default: 110×32)
#   CPS      typing chars/second    (default: 16 — natural human pace)
#
# Secret hygiene: RECALL_API_KEY must be in your env (inherited by the session)
# but is never printed. Don't `type` any command that echoes it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SESSION="${SESSION:-samocall-demo}"
CAST="${CAST:-$SCRIPT_DIR/samocall-live.cast}"
case "$CAST" in /*) ;; *) CAST="$REPO_ROOT/$CAST" ;; esac
COLS="${COLS:-110}"
ROWS="${ROWS:-32}"
CPS="${CPS:-16}"

cmd="${1:-}"; shift || true

require() { command -v "$1" >/dev/null 2>&1 || { echo "$1 not found — $2" >&2; exit 1; }; }

case "$cmd" in
  start)
    require tmux "brew install tmux"
    require asciinema "brew install asciinema"
    require claude "install Claude Code"
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    rm -f "$CAST"
    # tmux pane = the recorded PTY; asciinema records claude running inside it.
    tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS"
    tmux send-keys -t "$SESSION" \
      "cd '$REPO_ROOT' && asciinema rec '$CAST' --overwrite --idle-time-limit 3 --command '${CLAUDE_CMD:-claude}'" Enter
    echo "Started session '$SESSION' (${COLS}×${ROWS}) recording → $CAST"
    echo "Give claude a few seconds to boot, then drive it with: type / key / peek / wait"
    ;;

  type|send)
    # Character-by-character typing at CPS for a natural rhythm.
    text="${1:?usage: $cmd \"text\"}"
    delay="$(awk "BEGIN{printf \"%.4f\", 1/$CPS}")"
    for (( i = 0; i < ${#text}; i++ )); do
      tmux send-keys -t "$SESSION" -l "${text:$i:1}"
      sleep "$delay"
    done
    [ "$cmd" = "type" ] && { sleep 0.3; tmux send-keys -t "$SESSION" Enter; }
    ;;

  key)
    tmux send-keys -t "$SESSION" "${1:?usage: key <KeyName>}"
    ;;

  peek)
    tmux capture-pane -t "$SESSION" -p
    ;;

  wait)
    pat="${1:?usage: wait \"regex\"}"
    for _ in $(seq 1 120); do
      if tmux capture-pane -t "$SESSION" -p | grep -Eq "$pat"; then echo "matched: $pat"; exit 0; fi
      sleep 1
    done
    echo "timeout waiting for: $pat" >&2; exit 1
    ;;

  stop)
    # Exit claude → asciinema --command returns → cast is finalized.
    tmux send-keys -t "$SESSION" C-c 2>/dev/null || true
    sleep 0.5
    tmux send-keys -t "$SESSION" "/exit" Enter 2>/dev/null || true
    sleep 1
    tmux send-keys -t "$SESSION" C-d 2>/dev/null || true
    sleep 2
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    echo "Finalized cast → $CAST"
    echo "Render: ./demo/cast-to-gif.sh '$CAST'"
    ;;

  *)
    grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
