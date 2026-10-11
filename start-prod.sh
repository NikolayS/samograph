#!/usr/bin/env bash
# Samograph PROD launcher: starts API server (bg) + Next.js web (fg).
# Called by samograph-web.service (prod) and samograph-web@<env>.service (preview).
#
# APP_DIR resolution (in priority order):
#   1. $APP_DIR env var — explicit override (useful for testing)
#   2. $PWD — the directory systemd set as WorkingDirectory for this unit
#      - prod unit:    WorkingDirectory=/opt/samograph/app     → $PWD = /opt/samograph/app
#      - preview unit: WorkingDirectory=/opt/samograph/envs/%i → $PWD = the branch checkout
#
# This means prod behaviour is byte-identical to before (WorkingDirectory was already
# /opt/samograph/app on the prod unit), and preview envs now run THEIR branch's code
# instead of the hardcoded prod checkout.  No samohost unit change needed.
set -euo pipefail
APP_DIR="${APP_DIR:-$PWD}"
echo "samograph-prod: APP_DIR=${APP_DIR}, PORT=${PORT:-3000}, APP_API_ORIGIN=${APP_API_ORIGIN:-unset}, APP_API_PORT=${APP_API_PORT:-8787}" >&2
cd "${APP_DIR}"
/usr/local/bin/bun apps/app-api/server.ts &
API_PID=$!
echo "samograph-prod: API server started (pid ${API_PID})" >&2
cleanup() { kill "${API_PID}" 2>/dev/null || true; wait "${API_PID}" 2>/dev/null || true; }
trap cleanup EXIT SIGTERM SIGINT
cd "${APP_DIR}/apps/web"
echo "samograph-prod: starting Next.js on port ${PORT:-3000}" >&2
exec /usr/local/bin/bun run start
