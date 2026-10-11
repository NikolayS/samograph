#!/usr/bin/env bash
#
# dev-local.sh — stand up the FULL Sprint-1 samograph.dev stack LOCALLY.
#
# LOCAL ONLY. No VM/SSH, no deploy, no real secrets. Uses a local Docker
# Postgres, the in-repo Recall FAKE, and an in-memory email fake that prints the
# magic-link URL. Everything runs on this machine for click-through testing.
#
# Usage:
#   bash scripts/dev-local.sh            # start (idempotent): db + migrate + api + web
#   bash scripts/dev-local.sh start      # same as above
#   bash scripts/dev-local.sh stop       # stop api + web (Postgres container stays up)
#   bash scripts/dev-local.sh stop --db  # also stop the Postgres container
#   bash scripts/dev-local.sh status     # show what's running
#
# Logs: ./.dev-local/{app-api,web}.log    PIDs: ./.dev-local/{app-api,web}.pid
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── config (DEV-ONLY) ─────────────────────────────────────────────────────────
DB_CONTAINER="${DB_CONTAINER:-samograph-local}"
DB_USER="${DB_USER:-samograph}"
DB_PASS="${DB_PASS:-samograph}"
DB_NAME="${DB_NAME:-samograph}"
DB_PORT="${DB_PORT:-5432}"
export DATABASE_URL="${DATABASE_URL:-postgres://${DB_USER}:${DB_PASS}@localhost:${DB_PORT}/${DB_NAME}}"
APP_API_PORT="${APP_API_PORT:-8787}"
WEB_PORT="${WEB_PORT:-3000}"
# Live transport (ingest + ws-hub composed on one shared Hub — #99).
WS_HUB_PORT="${WS_HUB_PORT:-8788}"
INGEST_PORT="${INGEST_PORT:-8089}"
DEV_CTRL_PORT="${DEV_CTRL_PORT:-8790}"
APP_API_ORIGIN="http://localhost:${APP_API_PORT}"
LOGDIR="$ROOT/.dev-local"
mkdir -p "$LOGDIR"

log()  { printf '\033[0;36m[dev-local]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[dev-local]\033[0m %s\n' "$*"; }

port_listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
api_healthy()    { curl -fsS -o /dev/null "http://localhost:${APP_API_PORT}/health" 2>/dev/null; }
web_healthy()    { curl -fsS -o /dev/null "http://localhost:${WEB_PORT}/" 2>/dev/null; }
live_healthy()   { curl -fsS -o /dev/null "http://localhost:${DEV_CTRL_PORT}/health" 2>/dev/null; }

ensure_postgres() {
  if ! docker info >/dev/null 2>&1; then
    warn "Docker daemon not reachable. On macOS: open -a Docker, then re-run."
    exit 1
  fi
  if docker ps -a --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
    if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
      log "starting existing Postgres container '$DB_CONTAINER'"
      docker start "$DB_CONTAINER" >/dev/null
    else
      log "Postgres container '$DB_CONTAINER' already running"
    fi
  else
    log "creating Postgres container '$DB_CONTAINER' (postgres:16) on :$DB_PORT"
    docker run -d --name "$DB_CONTAINER" \
      -e POSTGRES_USER="$DB_USER" \
      -e POSTGRES_PASSWORD="$DB_PASS" \
      -e POSTGRES_DB="$DB_NAME" \
      -p "${DB_PORT}:5432" \
      postgres:16 >/dev/null
  fi
  log "waiting for Postgres to accept connections…"
  for _ in $(seq 1 60); do
    if docker exec "$DB_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      log "Postgres ready"; return 0
    fi
    sleep 1
  done
  warn "Postgres did not become ready in time"; exit 1
}

run_migrations() {
  log "running DB migrations (schema + RLS + samograph_app role)…"
  bun "$ROOT/packages/shared/db/migrate.ts"
}

start_api() {
  if api_healthy; then log "app-api already healthy on :$APP_API_PORT — skipping"; return 0; fi
  log "starting app-api (composed dev server) on :$APP_API_PORT"
  SAMO_ENV=dev APP_API_PORT="$APP_API_PORT" WEB_ORIGIN="http://localhost:${WEB_PORT}" \
    nohup bun "$ROOT/apps/app-api/dev-server.ts" >"$LOGDIR/app-api.log" 2>&1 &
  echo $! > "$LOGDIR/app-api.pid"
  for _ in $(seq 1 40); do api_healthy && { log "app-api up (pid $(cat "$LOGDIR/app-api.pid"))"; return 0; }; sleep 0.5; done
  warn "app-api did not become healthy — see $LOGDIR/app-api.log"; return 1
}

start_live() {
  if live_healthy; then log "live (ingest+ws-hub) already healthy on :$DEV_CTRL_PORT — skipping"; return 0; fi
  log "starting live transport (ingest :$INGEST_PORT + ws-hub :$WS_HUB_PORT, dev-ctrl :$DEV_CTRL_PORT)"
  SAMO_ENV=dev WS_HUB_PORT="$WS_HUB_PORT" INGEST_PORT="$INGEST_PORT" DEV_CTRL_PORT="$DEV_CTRL_PORT" \
    nohup bun "$ROOT/apps/ws-hub/dev-live-server.ts" >"$LOGDIR/live.log" 2>&1 &
  echo $! > "$LOGDIR/live.pid"
  for _ in $(seq 1 40); do live_healthy && { log "live up (pid $(cat "$LOGDIR/live.pid"))"; return 0; }; sleep 0.5; done
  warn "live did not become healthy — see $LOGDIR/live.log"; return 1
}

start_web() {
  if web_healthy; then log "web already serving on :$WEB_PORT — skipping"; return 0; fi
  log "starting web (next dev, under bun) on :$WEB_PORT"
  ( cd "$ROOT/apps/web" && APP_API_ORIGIN="$APP_API_ORIGIN" PORT="$WEB_PORT" \
      nohup bun run --bun dev >"$LOGDIR/web.log" 2>&1 & echo $! > "$LOGDIR/web.pid" )
  for _ in $(seq 1 60); do web_healthy && { log "web up (pid $(cat "$LOGDIR/web.pid"))"; return 0; }; sleep 1; done
  warn "web did not become healthy — see $LOGDIR/web.log"; return 1
}

kill_by_port() {
  local pids; pids="$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -n "$pids" ] && { echo "$pids" | xargs kill 2>/dev/null || true; }
}

do_start() {
  ensure_postgres
  run_migrations
  start_api
  start_live
  start_web
  cat <<EOF

=========================================================
  samograph.dev local stack is UP
    web (Next.js) : http://localhost:${WEB_PORT}
    app-api       : http://localhost:${APP_API_PORT}   (GET /health)
    dev magic link: http://localhost:${APP_API_PORT}/__dev/last-magic-link
    live ws-hub   : http://localhost:${WS_HUB_PORT}/calls/:id/stream (WS)
    live ingest   : http://localhost:${INGEST_PORT}/webhook
    live dev-say  : http://localhost:${DEV_CTRL_PORT}/__dev/say
    Postgres      : ${DATABASE_URL}
  logs: ${LOGDIR}/{app-api,live,web}.log
  stop: bash scripts/dev-local.sh stop   (add --db to also stop Postgres)
=========================================================

  Try it:
    1. open http://localhost:${WEB_PORT}  -> "Get started" -> enter any email
    2. grab the link: curl -s http://localhost:${APP_API_PORT}/__dev/last-magic-link
       (or read it from ${LOGDIR}/app-api.log)
    3. open that link -> "You're signed in" -> Go to dashboard
    4. paste https://meet.google.com/abc-defg-hij -> "Add to call" -> PENDING
    5. on the per-call page, stream a LIVE line into it (fake):
       curl -s http://localhost:${DEV_CTRL_PORT}/__dev/say \\
         -H 'content-type: application/json' \\
         -d '{"call_id":"<call_id>","speaker":"Alice","text":"hello live"}'
EOF
}

do_stop() {
  log "stopping web + live + app-api"
  for name in web live app-api; do
    if [ -f "$LOGDIR/$name.pid" ]; then
      kill "$(cat "$LOGDIR/$name.pid")" 2>/dev/null || true
      rm -f "$LOGDIR/$name.pid"
    fi
  done
  kill_by_port "$WEB_PORT"
  kill_by_port "$DEV_CTRL_PORT"
  kill_by_port "$WS_HUB_PORT"
  kill_by_port "$INGEST_PORT"
  kill_by_port "$APP_API_PORT"
  if [ "${1:-}" = "--db" ]; then
    log "stopping Postgres container '$DB_CONTAINER'"
    docker stop "$DB_CONTAINER" >/dev/null 2>&1 || true
  else
    log "Postgres container left running (use 'stop --db' to stop it)"
  fi
  log "stopped"
}

do_status() {
  api_healthy  && echo "app-api : UP   (http://localhost:${APP_API_PORT})" || echo "app-api : down"
  live_healthy && echo "live    : UP   (ws-hub :${WS_HUB_PORT}, ingest :${INGEST_PORT}, dev-say :${DEV_CTRL_PORT})" || echo "live    : down"
  web_healthy  && echo "web     : UP   (http://localhost:${WEB_PORT})"     || echo "web     : down"
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$DB_CONTAINER" \
    && echo "postgres: UP   ($DB_CONTAINER)" || echo "postgres: down"
}

case "${1:-start}" in
  start) do_start ;;
  stop)  do_stop "${2:-}" ;;
  status) do_status ;;
  *) echo "usage: $0 [start|stop [--db]|status]" >&2; exit 2 ;;
esac
