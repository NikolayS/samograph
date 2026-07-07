# samograph.dev — Engineering Hand-off

> Audience: a senior engineer with zero prior knowledge of this project, expected to be productive within an afternoon. Everything here is concrete; where something is unverified it says "verify".
> Last updated: 2026-07-07 (end of Sprint 2, before Sprint 3 kickoff).

---

## 1. TL;DR

**samograph.dev** is a hosted, zero-setup SaaS version of the `samograph` CLI: a Recall.ai bot joins a Zoom/Meet/Teams call and its live transcript streams to a per-call web page (shareable read-only, durable after the call). It is **live in production** at https://samograph-main.samo.cat.

**Current state:** Sprint 1 ("the seams") and Sprint 2 ("the live transcript") are DONE, merged, deployed, and live-verified with a real call. **Sprint 3 ("harden + ship") is next** — it is the final v1 sprint.

**The 5 things to read/do first:**

1. Read `blueprints/samograph-dev/SPEC.md` — the authoritative product/architecture contract.
2. Read `blueprints/samograph-dev/SPEC.amendments.md` — sanctioned deviations from SPEC (596 lines; SPEC != code in a few important places, e.g. webhook auth S2-10/S2-11).
3. Read the root `CLAUDE.md` — the mandatory dev process (Issues/PRs, strict TDD, the samorev merge gate). Non-negotiable.
4. Run `bash scripts/dev-local.sh` and do the manual click-through (§4 below) — the full stack locally with fakes, no secrets required.
5. Run `bunx tsc --noEmit && bun test` to confirm a green baseline (add `DATABASE_URL` to exercise the DB suite).

---

## 2. What we're building

**Product:** a Recall.ai bot joins a meeting; live transcript lines stream to a per-call web page. Owners sign in via magic-link email, add a meeting URL from the dashboard, watch the transcript live, share a read-only link, and download the transcript afterwards.

**Two-phase scope:**

| Phase | Scope |
|---|---|
| **v1** (this build) | Zero-setup hosted live transcript: auth, call creation, live stream, share links, download, status lifecycle, disclosure, watchdog. |
| **v2** (NOT built) | Secure bidirectional AI-agent channel into the call. Seams are pre-wired (bot-worker command surface, `act:*` token scopes) but nothing is implemented. |

**Relationship to the CLI:** the repo also contains the original published `samograph` CLI in `src/` (npm package, built to `dist/cli.js`). The SaaS **reuses** its pure pieces — transcript normalizer, Recall client, tunnel-health markers — rather than rebuilding them. Both are typechecked/tested in one pass.

**Source-of-truth hierarchy:** `SPEC.md` (what to build) > `SPEC.amendments.md` (approved deviations) > code. `CLAUDE.md` at the repo root is *how we work*.

---

## 3. Architecture & codebase map

Monorepo root: `/Users/new/samograph`. Bun workspaces: `apps/{web,app-api,ingest,ws-hub,bot-worker,bot-orchestrator}` + `packages/{shared,test-fakes/recall}`. Style throughout: **port/adapter with injected seams** — pure core + in-memory fake + Postgres/real adapter, so units test without DB or network. Postgres access is Bun-native `SQL` (`import { SQL } from "bun"`) — **Bun's SQL has no LISTEN/NOTIFY consumer**, which shapes the deployment (see liveBridge below).

### 3.1 Packages

**`packages/shared`** — the spine, imported by every app:
- `crypto.ts` — `sha256Hex` (single source; ingest_secret_hash, worker_secret_hash, share-cap keys).
- `db/client.ts` — `connect(url)`, `databaseUrl()`, and **`setTenant(tx, tenantId)`** = `SELECT set_config('app.tenant_id', $1, true)` — the ONE primitive every RLS policy reads (transaction-local; call inside `sql.begin`).
- `db/migrate.ts` + `db/migrations/0001…0006.sql` — schema + RLS (see §3.4).
- `auth/gate.ts` — **`authorizeCall(tx, req, deps)`**, the tenancy gate (§3.3).
- `tokens/signing.ts` (pure HMAC-SHA256 signer/verifier, KID rotation, scopes) + `tokens/store.ts` (DB mint/verify/revoke).
- `transcript/index.ts` — **`normalizeTranscriptLine`** + `renderTranscriptLine`/`renderTranscriptText` (download). Byte-identical to the CLI (`src/transcript.ts` re-exports it).
- `transcript/publisher.ts` — `TranscriptPublisher` port + in-memory + `PgListenNotifyPublisher`; lightweight NOTIFY signal `{k:"line",call_id,seq}`.
- `recall/signature.ts` — pinned webhook HMAC contract shared by the Recall fake (signer) and ingest (verifier), so the two sides can't drift.
- `observe/` — metrics registry + percentiles, activation funnel (§9 of SPEC), tenant-context-enforcing JSON logger, Prometheus `/metrics`.
- `serverLifecycle.ts` — `stopServerBounded` (ingest + ws-hub).

**`packages/test-fakes/recall`** — deterministic, seedable, network-free Recall fake (SPEC §6.1). `createRecallFake({seed})` produces byte-stable `transcript.data` and `bot.status_change` events plus signed webhook envelopes. **This is the Recall used on every PR**; the real Recall sandbox is a nightly job, never a PR gate.

### 3.2 Apps

**`apps/app-api`** — Bun/Hono control plane (:8787 in dev).
- `index.ts` is only a `/health` stub — **real routes are the `http.ts` handlers wired by `dev-server.ts`** (an integration seam, not a prod entrypoint).
- `auth/` — magic-link + session: `service.ts` (`AuthService`, rate limits `PER_EMAIL_LIMIT=5`, `PER_IP_LIMIT=20`), `token.ts`, `session.ts` (`signSession`/`verifySession`, cookie `samo_session`, HttpOnly/Secure/SameSite=Lax, 30d TTL), `keyring.ts`, `rate-limit.ts`, `stores.ts`/`pg-user-store.ts`, `email.ts`/`resend-email.ts` (`EmailSender` port + Resend adapter), `errors.ts` (SAMO-AUTH-001..004).
- `calls/http.ts` — `POST/GET /calls`, `GET /calls/:id`, share mint/list/revoke/rotate. Every tenant-scoped tx runs `SET LOCAL ROLE samograph_app` + `setTenant`. `calls/validate.ts` — Zoom/Meet URL patterns.
- `workers/discovery.ts` — `callWorker`: gate FIRST → RLS-scoped `workers` lookup → HTTP call with per-instance Bearer + `AbortSignal.timeout` → clean `SAMO-WORKER-503` on dead worker.

**`apps/bot-orchestrator`** — call creation + **the Recall key boundary**.
- `index.ts` — `orchestrateJoin`: pick region (`us-east` in v1) → generate 32-byte ingest secret → persist ONLY its SHA-256 hash → `recall.createBot` with webhook `…/webhook?bot=<id>&t=<secret>` → PENDING→JOINING. `runJoinJob` wraps it: on throw → `markCouldNotJoin` with `sanitizeFailureReason` (redacts the Recall key before persisting `status_reason`). `envSecretProvider` reads `RECALL_API_KEY` — the key lives ONLY here + ingest.
- `recallClient.ts` — fake by default; real client only iff `RECALL_LIVE`/`RECALL_AI` truthy AND `RECALL_API_KEY` set (fails fast otherwise — issue #88).
- `statusPoller.ts` — **10s privileged poller**: real Recall does NOT push `bot.status_change` over the realtime endpoint (#118), so this polls `GET /api/v1/bot/<id>/` `status_changes`, drives `calls.status` (forward-only), posts the §5.9 in-call disclosure exactly once (durable `calls.disclosure_posted_at`, send-then-stamp), publishes status frames.

**`apps/ingest`** — webhook ingress, the security-critical front door (:8089 in dev).
- `webhook.ts` — `createWebhookHandler`: `POST /webhook?[bot=]&t=…`. Auth order (per amendments S2-10/S2-11): (1) Recall signature verified only if header present; (2) resolve call by `?bot=`→`recall_bot_id` or by `?t=`→`ingest_secret_hash`; (3) constant-time `?t=` check; (4) tenancy gate + `setTenant`. Idempotent via `webhook_events (bot_id, recall_event_id)` INSERT ON CONFLICT. Fails closed (bodyless 401/403, one WARN, `webhook_rejected_total{reason}`). Dispatch runs INSIDE the dedup tx.
- `transcriptPipeline.ts` — normalize → append `transcripts` row (monotonic per-call `seq`, advisory-lock serialized) → set `first_line_at` once → publish `{call_id,seq}`.
- `botLifecycle.ts` — `mapLifecycleCode`: `in_call_recording`→IN_CALL+disclosure; `in_call_not_recording`→COULD_NOT_RECORD (+leave, NO disclosure; escalates only from PENDING/JOINING); `call_ended`→ENDED; `bot_removed`→BOT_REMOVED; `fatal`→COULD_NOT_JOIN+reason. Terminal status is sticky. `DISCLOSURE_TEXT` is byte-exact.
- `tunnelWatchdog.ts` — `startRegionWatchdog`: leader-elected (Postgres advisory lock + 60s lease on `regions`) per-region probe of `/health?nonce` every 20s; 2 consecutive fails → region degraded → `calls.ingest_degraded=true` for IN_CALL calls + `SAMOGRAPH-WARNING: tunnel unreachable` transcript line (CLI text reused). Recovery reverses.

**`apps/ws-hub`** — live stream fan-out (:8788 in dev).
- `hub.ts` — per-call bounded fan-out: `MAX_QUEUE_MESSAGES=256` OR `MAX_QUEUE_BYTES=512KB`, overflow = drop-oldest + one `{type:"gap",since_seq,until_seq}` frame. Control frames never dropped.
- `stream.ts` — `GET /calls/:id/stream` WS: `authorizeCall` once, subscribe-before-read then backfill-then-live (dedupe on boundary seq), `?since_seq` replay, **gate re-check every 1s** → revoke closes the socket ≤1s.
- `caps.ts` — share-scope caps: 200 concurrent / 20 cmds per 60s / 1000 establishes per hour → `SAMO-RATE-001`.
- `transcript-http.ts` — `GET /calls/:id/transcript?since_seq=N` REST gap-resync + `.txt`/`.md` download.
- `fanIn.ts` — consumes the lightweight `{call_id,seq}` signal, re-hydrates the row under RLS, `hub.publish`.
- `liveBridge.ts` — **`composeLiveStack`: ingest + ws-hub composed in ONE process** over a shared in-process Hub, because Bun SQL cannot consume LISTEN/NOTIFY. The cross-process `PgListenNotifyPublisher` exists but is unused. This is how prod runs too.
- `dev-live-server.ts` — the composed entrypoint (also used in prod by systemd; see §5).

**`apps/bot-worker`** — process-per-call command surface (`POST /v1/call/:id/{chat,presence,leave}`, `GET …/{frames,frame}`, Bearer-authed; `registry.ts` writes hashed worker secrets to `workers`). In v1 called only by app-api discovery; it is the pre-wired v2 agent seam.

**`apps/web`** — Next.js 15 / React 19 App Router: landing, `app/auth/*` (magic link), `app/dashboard`, `app/calls/[id]` (owner view), `app/c/[token]` (read-only share view). `lib/` has typed clients (`appApiClient.ts` + fake, `transcriptStreamClient.ts` + fake, `shareApiClient.ts`, `apiError.ts` with SAMO codes). `next.config.mjs` — dev-only same-origin proxy to `APP_API_ORIGIN`, disambiguating page vs fetch on `Sec-Fetch-Dest`.

**`src/`** — the original CLI. Reused pieces: `transcript.ts` (re-exports shared normalizer), `recall.ts` (real Recall client used by the orchestrator live path), `server.ts` (`HEALTH_MARKER`, `probeTunnelHealth`, tunnel warning strings — all reused by ingest).

### 3.3 Core abstractions (learn these before touching anything)

- **Tenancy gate** — `packages/shared/auth/gate.ts` `authorizeCall(tx, req, deps)`. The ONE entry for any call access. Session cookie → derived `read` scope (`setTenant` then RLS `SELECT 1 FROM calls WHERE id=$callId`; zero rows = not yours). Share/agent token → `verifyToken` + explicit call binding. Fails closed to a frozen DENY (403, no body, `SAMO-AUTHZ-001`) on ANY error. No cache → revoke is effective on the next check.
- **Capability tokens** — `base64url(body).base64url(HMAC-SHA256(secret, body))`, body `{kid,call_id,scopes[],iat,exp,jti}`. `read` is NEVER persisted to the `tokens` table (only `share` + `act:*`); `jti` UNIQUE prevents replay; KID rotation accepts current+previous (90d/30d overlap); constant-time compares everywhere.
- **Recall key boundary** — the shared Recall API key exists ONLY in bot-orchestrator + ingest env. Never in any API response, log, or agent hand-off; `sanitizeFailureReason` redacts it from persisted failure reasons.
- **Status lifecycle** — driven by bot events (poller or webhook), NOT transcript traffic; silent calls still reach IN_CALL. Statuses: `PENDING|JOINING|IN_CALL|ENDED|COULD_NOT_JOIN|COULD_NOT_RECORD|BOT_REMOVED`; terminal is sticky; `ingest_degraded` is an independent boolean overlay, trigger-reset on terminal.
- **Errors** — stable `SAMO-…` codes (SPEC §5.16), mirrored in `apps/web/lib/apiError.ts` and each package's `errors.ts`.

### 3.4 Data model (`packages/shared/db/migrations/`)

The app connects as **non-superuser, non-owner role `samograph_app`** so RLS actually applies (`ENABLE` + `FORCE`). Every policy uses the mandatory InitPlan wrapper `tenant_id = (SELECT current_setting('app.tenant_id'))::uuid` — **do not break this pattern**; it is load-bearing for both isolation and per-statement (not per-row) evaluation. `users` and `regions` are not granted to the role (privileged pre-tenant paths).

| Table | Purpose | RLS |
|---|---|---|
| `users` | id, email UNIQUE | none (privileged) |
| `tenants` | 1:1 with owner user | `id = app.tenant_id` |
| `calls` | status enum, recall_bot_id, meeting_url, region, `ingest_secret_hash`, `status_reason` (0004), `disclosure_posted_at` (0006), `ingest_degraded` overlay + terminal-reset trigger | tenant_id |
| `transcripts` | PK `(call_id,seq)`, append-only | via calls |
| `tokens` | persisted scopes only (`share`/`act:*` — never `read`), kid, jti UNIQUE, revoked_at | via call's tenant |
| `audit_log` | actor, action, payload_sha256 | tenant_id |
| `workers` | call_id PK, host/port, worker_secret_hash | via call's tenant |
| `regions` | tunnel status + leader lease | none (infra) |
| `webhook_events` | PK `(bot_id,recall_event_id)` idempotency ledger (0003) | via calls join |

### 3.5 Key flows

- **Auth:** `POST /auth/magic-link` → rate-limited, HMAC+KID token, 15 min, emailed → `GET /auth/callback?token` → constant-time verify, single-use (replay → SAMO-AUTH-003) → signed 30d `samo_session` cookie.
- **Create call → live transcript:** dashboard `POST /calls` → PENDING row + orchestrator job → `orchestrateJoin` (secret, hash, `recall.createBot`, JOINING) → Recall POSTs `/webhook` → authenticity + dedup → dispatch (transcript append + publish; lifecycle → status) → fan-in re-hydrates under RLS → Hub → WS → page.
- **Share:** owner mints (`scopes=['share']`, 30d) → reader opens `/c/[token]` → gate + call binding + ShareCaps. Revoke stamps `revoked_at`; open sockets close within 1s via the stream re-check.

### 3.6 Gotchas (memorize)

1. `apps/*/index.ts` are `/health` stubs — real servers are `dev-server.ts` / `server.ts` / `dev-live-server.ts`.
2. v1 runs ingest+ws-hub in ONE process (`liveBridge`) because Bun SQL can't consume LISTEN/NOTIFY — in dev AND prod.
3. The real Recall webhook has NO signature header and NO `?bot=` at register time — auth rests on `?t=` → `ingest_secret_hash` (amendments S2-10/S2-11), diverging from SPEC §5.3's signature-first framing.
4. Recall bot status must be POLLED (`statusPoller.ts`), not awaited from the webhook.
5. Never break the `(SELECT current_setting(...))` RLS wrapper or the `samograph_app` role.
6. Check `SPEC.amendments.md` before treating `SPEC.md` as literal.

---

## 4. Local dev: build, run, test

### Toolchain

**Bun is the only toolchain** (>=1.2.0; 1.3.14 installed locally). `Bun.serve` for HTTP/WS, Bun `SQL` for Postgres (no pg/Prisma), `bun:test` runner, direct `.ts` execution (nothing transpiled to run). TypeScript ^5.9.3 for `tsc --noEmit` only. Next.js 15 + React 19 for `apps/web`. Docker only for local Postgres.

```bash
cd /Users/new/samograph
bun install                       # all workspaces (CI: bun install --frozen-lockfile)
```

### One-command stack

```bash
bash scripts/dev-local.sh          # start: Docker postgres:16 + migrate + app-api + live + web
bash scripts/dev-local.sh status
bash scripts/dev-local.sh stop     # (--db to also stop Postgres)
```

Runs with the in-repo Recall fake and a dev email fake (prints the magic link) — **no real secrets needed**. Logs/PIDs in `.dev-local/` (status output is the source of truth, not stale PID files).

| Service | Port(s) | Entry | Notes |
|---|---|---|---|
| app-api | 8787 | `apps/app-api/dev-server.ts` | auth, calls, share, `GET /__dev/last-magic-link` |
| live (ingest+ws-hub) | 8788 ws / 8089 webhook / 8790 dev-ctrl | `apps/ws-hub/dev-live-server.ts` | `POST /__dev/say` injects a line without webhook auth |
| web | 3000 | `apps/web` (`bun run --bun dev`) | proxies API to `APP_API_ORIGIN` |

Manual click-through: open `http://localhost:3000` → Get started → any email → `curl -s http://localhost:8787/__dev/last-magic-link` → open link → dashboard → paste `https://meet.google.com/abc-defg-hij` → Add to call → then `curl -s http://localhost:8790/__dev/say -H 'content-type: application/json' -d '{"call_id":"<id>","speaker":"Alice","text":"hello live"}'`.

DEV-only shortcuts baked into the seams (never production): constant fallback secrets shared between app-api and ws-hub (kid `dev-share`), cookie `Secure` stripped for `http://localhost`, fake email/Recall by default. To go live from the same seam: `RESEND_API_KEY`+`MAGIC_LINK_FROM` (real email), `RECALL_LIVE=1`+`RECALL_API_KEY`+`PUBLIC_WEBHOOK_BASE` (real bot; fails fast if the key is missing — #88). See `docs/runbooks/real-recall-flag.md`.

### Postgres & migrations

```bash
DATABASE_URL=postgres://samograph:samograph@localhost:5432/samograph \
  bun packages/shared/db/migrate.ts
# or: cd packages/shared && bun run db:migrate
```

Plain SQL files applied in lexical order (`0001`…`0006`), each in its own transaction, recorded in `schema_migrations`, idempotent.

### Test & typecheck

```bash
bun test               # everything: CLI + all workspaces (121 test files)
bunx tsc --noEmit      # repo-wide (root tsconfig globs src/tests/apps/packages)
```

Conventions:
- **DB-gated tests auto-skip without `DATABASE_URL`** (`const d = HAVE_DB ? describe : describe.skip`). Set it to run them; new DB tests need NO CI edit — CI's `postgres-smoke` job runs the whole suite against an ephemeral `postgres:16` with real migrations + real RLS.
- **Strict red/green TDD is mandatory** (see §8): failing test first, RED output pasted in the PR, then GREEN. Assert exact values, not existence.
- **Web component tests** use Happy DOM via `installDom()` from `apps/web/test/setup.tsx` (per-file register/unregister — Bun shares one process, DOM globals must be torn down).

CI (`.github/workflows/ci.yml`): `test` (tsc + bun test + CLI build, no DB), `postgres-smoke` (full suite with DB), `benchmark-runner` (`apps/ws-hub/bench/main.ts`, p99 ≤ 5ms WS SLO — asserts only on an isolated runner via `BENCH_RUNNER_LABEL`, skips loudly on shared CI).

### Local-setup gotchas

- `databaseUrl()` throws if `DATABASE_URL` unset; without it DB tests skip (green but unexercised).
- Fresh worktree: run `bun install` before `bunx tsc --noEmit` or tsc reports phantom `src/` type errors.
- `next.config.mjs` and `apps/web/test/setup.tsx` are `.mjs`/`.tsx` **on purpose** to stay out of the root `.ts` tsc glob — don't rename.
- Ports 3000/8787/8788/8089/8790/5432 must be free (overridable: `WEB_PORT`, `APP_API_PORT`, `WS_HUB_PORT`, `INGEST_PORT`, `DEV_CTRL_PORT`, `DB_PORT`).

---

## 5. Deployment & operations

### Live production setup

- **Hetzner VM**: `ssh -p 2223 dev@116.203.249.135`. Public traffic goes through Cloudflare at **https://samograph-main.samo.cat** — always use the domain; the raw IP is firewalled.
- **Caddy** (`/etc/caddy/sites.d/samograph-main.caddy`) routes: `/calls/:id/stream` + `/calls/:id/transcript*` → ws-hub (localhost:8788); `/webhook*` + `/health` → ingest (localhost:8089); everything else → web (localhost:3100, `next start`).
- **systemd** (templated `@samograph-main`): `samograph-web` (app-api :8787 + web :3100 via `start-preview.sh`) and `samograph-live` (ingest + ws-hub composed in ONE process via `apps/ws-hub/dev-live-server.ts` — Bun SQL has no cross-process LISTEN, so they must share an in-process Hub).
- **Secrets**: `/opt/samograph/envs/samograph-main/.env` (root-600, NEVER committed): `RECALL_API_KEY`, `RESEND_API_KEY`, `SESSION_SECRET`, `TOKEN_SECRET`, `RECALL_WEBHOOK_SECRET`, `DATABASE_URL`, `APP_API_ORIGIN`, `PUBLIC_WEBHOOK_BASE`, `MAGIC_LINK_FROM=samograph@samo.cat`. No secret value appears anywhere in the repo.
- The VM currently tracks main @ `74a73e8` (verify before deploying — it may have moved).

### Deploy procedure

1. `ssh -p 2223 dev@116.203.249.135`
2. `sudo git -C <envdir> fetch origin main && sudo git -C <envdir> reset --hard origin/main`
3. Apply migrations: `bun packages/shared/db/migrate.ts` (with the VM `DATABASE_URL`).
4. Rebuild web: `sudo env APP_API_ORIGIN=<origin> bun run build` **inside `apps/web`**. **CRITICAL:** if you omit `APP_API_ORIGIN` the Next.js rewrites silently drop and the API stops routing.
5. Restart both systemd units (`samograph-web@samograph-main`, `samograph-live@samograph-main` — verify exact unit names on the VM).

### OPERATIONAL GOTCHAS — read before touching prod

- **RECALL_API_KEY is HIGHLY sensitive.** Never log, commit, screenshot, or echo it. It lives only in the VM `.env` (and the operator's local shell). The codebase redacts it from persisted failure reasons; keep it that way.
- **fail2ban will ban your SSH source IP** under too many connections — e.g. many parallel agents each SSHing. This locked out the team AND the tooling for ~an hour during Sprint 2. Team IPs (98.97.137.34, 98.97.143.153, 2605:59c8:33cb:4c10::/64) are whitelisted at runtime in the `sshd` and `recidive` jails, but **drop-in persistence is only partial** — the whitelist may not survive restarts (verify). If SSH is refused: do NOT hammer it (each attempt resets the ban timer); wait ~20 minutes or connect from a different network. Avoid many parallel agents SSHing the VM.
- **Email is REAL in prod** via Resend (verified domain samo.cat, from `samograph@samo.cat`). The `/__dev/last-magic-link` exposure is DISABLED in prod. To get an authed session for testing without sending email: mint a session cookie with `apps/app-api/auth/session.ts` `signSession()` + the VM's `SESSION_SECRET`.

---

## 6. Current state

### Sprint 1 — "the seams" (DONE)
Postgres schema + RLS + migrations; magic-link auth; `/calls` create+read; capability tokens; tenancy gate; transcript normalizer; bot-orchestrator; one regional tunnel.

### Sprint 2 — "the live transcript" (DONE, deployed, live-verified)
- Real Recall webhook ingest (real payload shape differs from the CLI's — see issue #120).
- Transcript persistence + ws-hub stream: cold backfill, `?since_seq` resume, `final:true` line frames, share/read caps + backpressure.
- **Status poller** (#118): real Recall does not deliver `bot.status_change` on the realtime endpoint — a 10s poller reads `GET /bot/:id/` and drives JOINING→IN_CALL→ENDED.
- COULD_NOT_JOIN failure UX (Story 4); share flow end-to-end (Story 2); transcript `.txt` download (Story 3); tunnel-outage watchdog (Story 5); dashboard rows as obvious tappable transcript links; live status without reload (#106); in-call recording disclosure (#117 / SPEC §5.9).

### Verified LIVE (real call + prod smoke tests)
Fresh bot join → IN_CALL; live multilingual streaming; disclosure fired (audit-logged); share mint/revoke + `/c` share page; transcript.txt; watchdog probing (region healthy).

### Test-covered but NOT drilled live
- A silent call (no speech) reaching IN_CALL.
- A forced tunnel outage showing the degraded banner.

### The samorev gate caught 3 real bugs on the Sprint-2 consolidation (all fixed + re-gated PASS) — cautionary tales:

1. **#106 cross-process WS status push never reached an open page** — there is no LISTEN consumer in Bun SQL, so the server-side push silently went nowhere. Replaced with a **client-side poll** (GET `/calls/:id` ~4.5s while non-terminal).
2. **Disclosure was at-least-once** — a post-send transaction rollback re-posted the disclosure on every poller sweep. Fixed with a durable `calls.disclosure_posted_at` marker, send-outside-tx, send-then-stamp.
3. **Destructive status regression** — an aged `in_call_not_recording` event could flip a LIVE IN_CALL call to terminal COULD_NOT_RECORD and eject the bot. Fixed: COULD_NOT_RECORD escalates only from PENDING/JOINING.

Moral: green CI is not a review; the gate exists because it works.

---

## 7. SPEC deviations (must also live in `blueprints/samograph-dev/SPEC.amendments.md`)

1. **#106 live status uses a CLIENT poll** (GET `/calls/:id` every ~4.5s while non-terminal), not the spec'd cross-process WS status push — Bun SQL has no LISTEN consumer API. The server-side status-frame path exists but works only in-process.
2. **Disclosure idempotency via durable `calls.disclosure_posted_at`** (send-then-stamp; duplicates bounded to that window), not the spec'd in-transaction guard.
3. **The outage watchdog probes a public `/health` route** (added to Caddy → ingest) returning the §4.5 marker.
4. **COULD_NOT_RECORD escalates only from PENDING/JOINING** — never regresses a live IN_CALL row.
5. **Webhook auth model** (amendments S2-10/S2-11): the real Recall realtime webhook carries no signature and no `?bot=` at registration, so authenticity rests on the constant-time `?t=` → `ingest_secret_hash` check; signature is verified only when the header is present. Diverges from SPEC §5.3's signature-first framing.

As of this hand-off, all 5 deviations above are now recorded in `SPEC.amendments.md` (entries 1–4 as S2-13 through S2-16; the webhook-auth model as S2-10/S2-11). It is 596 lines and covers more — read it in full.

---

## 8. How we work (mandatory — root `CLAUDE.md` is authoritative)

- **All work flows through GitHub Issues + PRs.** No direct commits to `main` (protected). Issues read like specs: Context / In-scope / Out-of-scope / red-green acceptance criteria / exact SPEC refs (`§5.x`, `§6.2 #n`).
- **Strict red/green TDD.** Failing test first; PR description pastes the RED failure and the GREEN pass. Assert exact values. One logical change per PR.
- **Branches:** `type/slug` embedding the issue number (`feat/…`, `fix/<n>-…`); agent branches `claude/<slug>-<hash>`. **Commits:** Conventional Commits with scope, subject <50 chars, co-authored trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Never amend a pushed commit; never force-push without explicit human confirmation.
- **The samorev merge gate — every PR, no exceptions:**
  1. CI green (`bun test` + `bunx tsc --noEmit`, Postgres integration green).
  2. samorev review posted as a PR comment: `bun run samorev review https://github.com/<owner>/<repo>/pull/<n> --fetch` (deterministic CI/draft gate) **plus** real code analysis via the `/review-mr` slash command or the samorev Security + Bug-Hunter agents (both BLOCKING). BLOCKING findings block; NON-BLOCKING/POTENTIAL/INFO count as PASS. Ignore SOC2 findings.
  3. Live-test evidence posted where it makes sense (commands + output, screenshots for UI).
  4. **Re-review after ANY post-review commit** — a PASS is bound to the head SHA; any later push (including a conflict-resolution merge or the fix for the review's own findings) VOIDS it. Pre-merge, every time: `gh pr view <n> --json headRefOid --jq .headRefOid` must equal the SHA the latest PASS ran against. Then squash-merge + delete branch. Human owner approval required for merge.
- **Agent-based manager model:** the orchestrator acts as engineering manager — decomposes the sprint into Issues, spawns engineer agents (one Issue each) and reviewer agents, integrates, and never does the code legwork itself. Engineers post intermediate progress as issue comments.
- **One sprint at a time.** STOP at sprint exit for human manual testing (SPEC §6.3 plan + exit checklist); verify shipped items against SPEC §4/§5/§6.2; record every intentional deviation in `SPEC.amendments.md` — never silent drift.
- **Stubs & secrets:** every external integration sits behind an interface with an in-repo fake (Recall fake, `EmailSender` fake, CI ephemeral Postgres). NEVER put real keys/tokens in issues, PR comments, or commits; rotate immediately on any leak.

---

## 8.5 Delivering PRs → the samorev gate → deploy

**1. Deliver the PR**
- One logical change per PR, branched off `main` (`fix/<n>-slug`, `feat/<area>-slug`; agent branches `claude/<slug>-<hash>`).
- **Red/green TDD:** failing test first — paste the RED failure *and* the GREEN pass in the PR body.
- **CI green:** `bun test` + `bunx tsc --noEmit` clean; Postgres-backed tests green on the CI ephemeral `postgres:16`.
- Conventional Commit with scope; co-authored trailer.

**2. Run the samorev gate — the merge gate; no merge without it**
- Two surfaces, both required:
  - **Deterministic:** `bun run samorev review <PR-url> --fetch` → posts a PASS/FAIL comment (checks CI status + draft state only).
  - **Code analysis:** `/review-mr`, or spawn the samorev **Security + Bug-Hunter** agents (both BLOCKING). In practice we run them as fable/medium reviewers over `git diff origin/main...HEAD`, and **adversarially verify each finding** before it counts (a second agent tries to *refute* it — kills false positives).
- **Severity:** only a *confirmed BLOCKING* finding blocks (security hole, auth/tenancy bypass, secret leak, data corruption, or a correctness bug that breaks the feature or a guarantee). NON-BLOCKING / POTENTIAL / INFO = PASS. **Ignore SOC2 findings.**
- Post the combined verdict as a PR comment; fix BLOCKING findings, then re-gate.

**3. Re-review after ANY post-review commit — the rule that actually bites**
- A samorev PASS is bound to the head SHA. **Any** later push — a fix, an amend, a rebase, a conflict-resolution merge, *even the commit that fixes the review's own findings* — **VOIDS the PASS.** Re-run the gate on the new HEAD.
- Pre-merge, every single time: `gh pr view <n> --json headRefOid --jq .headRefOid` must equal the SHA the latest PASS ran against, and CI must be green on it.

**4. Merge**
- Squash-merge, delete branch: `gh pr merge <n> --squash --delete-branch`. Human owner approval required.
- **Sprint/batch consolidation:** put the related PRs on one branch, run the gate **on the merged diff** (the analysis must see the merged code), then squash to `main`. That's how Sprint 2 shipped — and how the gate caught the 3 bugs.

**5. Deploy to prod — the VM tracks `main`**
SSH to the VM (`ssh -p 2223 dev@116.203.249.135`) and:
1. `sudo git -C /opt/samograph/envs/samograph-main fetch origin main && sudo git -C … reset --hard origin/main`
2. **Migrations:** `bun packages/shared/db/migrate.ts` (with the VM `DATABASE_URL`) — idempotent.
3. **Rebuild web:** `sudo env APP_API_ORIGIN=<origin> bun run build` **inside `apps/web`** — omit `APP_API_ORIGIN` and the Next.js rewrites silently drop, the API stops routing.
4. **Restart both units:** `samograph-web@samograph-main` + `samograph-live@samograph-main`.
5. **Smoke-test live** on https://samograph-main.samo.cat — health, an authed endpoint, and the changed feature. The gate catches *code* bugs; only a live check catches *deploy/routing/config* bugs (the `/health` route, the `APP_API_ORIGIN` trap, a false-degraded watchdog).

**SSH discipline:** don't hammer SSH, and don't run many parallel agents against the VM — fail2ban locks you out (~20 min). See section 5.

---

## 9. Next work — Sprint 3 "harden + ship" (SPEC §8, final v1 sprint)

By track:

| Track | Scope |
|---|---|
| **Security** | Rate limits: magic-link 5/hr/email + 20/hr/IP (independent); bot-creation per tenant; WS connections per call with distinct read-vs-share caps. Final review of tenancy gate, token verifier, webhook authenticity, RLS. |
| **Multi-region** | Deploy a SECOND region behind the same regional-tunnel pattern (proves the seam; NOT a launch gate) + region-selection policy (SPEC §4.7). |
| **Deliverability** | Magic-link tested against Gmail + at least one corporate mailbox; SPF/DKIM/DMARC live. |
| **Frontend polish** | Past-calls list; terminal-failure UX incl. COULD_NOT_RECORD copy; empty/loading states; final marketing copy. |

**Sprint-2 head start:** transcript download (Story 3) and the COULD_NOT_JOIN reason UX (Story 4) are already DONE — do not re-scope them into Sprint 3.

**Sprint-3 exit = ship v1:**
- Full SPEC §3 story acceptance pass.
- W1-activation metric instrumented (SPEC §5.11).
- Pickup-latency SLO observed in staging.
- Deploy to prod with the primary region serving and the second region warm.

---

## 10. Known open items, risks & non-blocking nits

**Open items:**
- Activation-funnel + pickup-latency instrumentation (SPEC §5.11) is not fully built (partial scaffolding exists in `packages/shared/observe/`).
- Second region not deployed.
- Recall sandbox nightly job is a non-PR gate — confirm it exists and is green (verify).
- Silent-call → IN_CALL and forced-outage degraded banner: test-covered, never drilled live.

**Non-blocking nits (from the last gate):**
- The poller tick log says "rolled back" even when only a post-commit disclosure send failed (misleading, not incorrect behavior).
- The client status-poll has no in-flight guard — a slow response can briefly regress the displayed status vs a fresher value; self-corrects on the next tick.
- ~4.5s first-poll latency before the page reflects a status change.
- The share-scope reduced call view is a denylist, not an allowlist — flip it during the Sprint-3 security review.

**Risks:**
- The in-process liveBridge composition means ingest and ws-hub scale (and fail) together; the pg_notify cross-process path is written but unused pending a Bun LISTEN consumer.
- Webhook authenticity rests entirely on the per-call `?t=` secret (hash-persisted) — the Sprint-3 security track should re-review it.
- fail2ban lockouts remain possible under parallel-agent SSH (whitelist persistence only partial).

**Runbooks:** `docs/runbooks/` — `real-recall-flag.md`, `could-not-join.md`, `ingest-degraded.md`, `leader-election.md`, and others.
