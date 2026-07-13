#!/usr/bin/env bash
# Hosted web + app-api supervisor. This file is versioned with the deployed SHA;
# samohost sets WorkingDirectory and the per-environment listener variables.
set -euo pipefail

children=()

stop_children() {
  local pid
  for pid in "${children[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "${children[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
}

trap stop_children EXIT INT TERM

/usr/local/bin/bun apps/app-api/server.ts &
children+=("$!")

(
  cd apps/web
  exec /usr/local/bin/bun run start
) &
children+=("$!")

set +e
wait -n "${children[@]}"
status=$?
set -e

# Either process exiting makes the composed service unhealthy. Stop its peer
# and return the first exit status so systemd's Restart=on-failure can recover.
if [[ "$status" -eq 0 ]]; then
  status=1
fi
exit "$status"
