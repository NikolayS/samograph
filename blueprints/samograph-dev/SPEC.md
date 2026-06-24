# samograph.dev — SPEC v0.2

## 1. Goal & why it's needed

**Goal.** Ship a hosted, fully-managed SaaS at `samograph.dev` that wraps the existing `samograph` CLI and its Recall.ai meeting bot so an end user NEVER runs the CLI, manages a Recall token, or sets up an ngrok/cloudflared tunnel. v1 delivers exactly one experience: *sign in → paste a Zoom or Google Meet URL → the bot is in the call → a per-call page streams a live, persisted transcript that's also shareable read-only.* v2 layers a **secure bidirectional AI-agent channel** on top of any active call.

**Why this exists.** samograph is fundamentally about **AI agents participating in live meetings** (Claude Code, Codex, etc.). The CLI proves the capability surface — `join`, `watch`, `chat`, `presence`, `frame`, `frames`, `leave` — but it forces every user to install Bun, hold a Recall API key, run a local callback server, and operate an ngrok/cloudflared tunnel. That setup tax is the only thing standing between "AI agent in your meeting" and a turnkey product. The hosted product removes that tax in v1 and uses v1 as the platform on which v2's scoped, revocable AI-agent channel is mounted. v1 alone (zero-install, live, persisted, shareable transcript) is already differentiated against Otter/Fireflies/Read/tl;dv for this use case; v2 is the strategic differentiator that no general meeting-notes product offers.

**Explicit non-goals for v1 (do not silently re-introduce):** no calendar integration, no Google OAuth, no AI features in the product UI, no billing, no plans/seats, no video storage, no AI-generated summaries, no email digests, no MS Teams, no consistent/branded bot identity, no multi-language UI. The Phase-2 AI-agent channel is designed for but **not built** in v1; only the **seams** ship in v1 (per-call token model, command/act API in the bot worker, per-call auth, capability scoping, audit log).

## 2. Scope phases (authoritative)

### v1 — MVP (the entire build target, this week)
- Marketing + app at `samograph.dev`.
- Email magic-link auth only (passwordless).
- Dashboard with ONE primary action: "Add samograph to a call" (paste Zoom or Google Meet URL).
- Bot joins immediately via shared server-side Recall API key.
- Per-call page streams transcript live over WebSocket, line-by-line, no reload, no polling. Each line: `[timestamp] Speaker: utterance`.
- Per-call page is shareable read-only via a signed link.
- Transcript persists to Postgres in real time, durable beyond Recall's ~7-day video retention.
- Server-operated, multi-tenant equivalent of `samograph join`: one shared Recall API key (in secret manager), one persistent cloudflared **named** tunnel per region, webhook ingest routed by `bot_id`, WS fan-out hub.
- In-call recording disclosure (bot name + chat post on join) so two-party-consent jurisdictions are addressed at the participant level, not just the dashboard (§10 #4).

### v2 — Phase 2 (next, deliberately deferred but architecturally pre-wired)
- Secure bidirectional AI-agent channel for an active call. The signed-in owner mints a per-call, capability-scoped, short-TTL, revocable token they paste into an external AI tool.
- **LISTEN scope:** subscribe to live transcript + bounded backfill.
- **ACT scope:** remote equivalents of `chat`, `frame`, `frames`, `presence`, `leave`. (1:1 with existing CLI verbs; the bot worker already supports them.)
- Exposed as HTTP + WebSocket API and an MCP server endpoint.
- Hard tenant isolation: an agent NEVER sees the Recall token, other calls, or other tenants. Full audit log of every act-channel call. Rate limits on the act channel. One-click revoke.

### v3+ — explicitly deferred (do not design into v1)
Billing/plans/seats; Google Calendar auto-join; branded/consistent bot identities; post-call transcript email; multi-language UI; long-term video storage + synced transcript+video viewer; MS Teams.

## 3. User stories (manual-test backbone)

### v1 stories

**Story 1 — Zero-setup live transcript (primary v1 JTBD).**
- *Persona:* AI-forward engineer who already uses Claude Code / Codex and wants samograph in calls without local CLI + Recall token + tunnel.
- *Action:* opens `samograph.dev`, enters email, clicks the magic link, lands on dashboard, pastes a Zoom URL, clicks "Add to call".
- *Outcome:* the per-call page opens in ≤ 2 s of submit; status reaches `JOINING` within ≤ 5 s of submit; status reaches `IN_CALL` when Recall reports admission (typically 10–30 s, depending on host approval — partly outside our control, so the SLO is on our pickup latency, not Recall's). Once `IN_CALL`, transcript lines start streaming live. Closing and re-opening the tab resumes without loss. After the call ends, the full transcript remains in the dashboard.

**Story 2 — Share the live transcript read-only.**
- *Persona:* same engineer (or a non-signed-in colleague / participant with hard-to-understand accent / multilingual viewer).
- *Action:* on the per-call page, owner clicks "Share" → gets a signed read-only URL → sends it to a teammate.
- *Outcome:* recipient opens the URL without signing in and sees the live transcript stream in real time, read-only (no controls to leave, mint AI tokens, or see other calls). The link is revocable from the owner's dashboard and stops working within ≤ 1 s of revoke.

**Story 3 — Durable transcript after Recall's video TTL.**
- *Persona:* engineer reviewing a meeting 10 days later (past Recall's ~7-day video retention).
- *Action:* opens dashboard → "Past calls" → selects the call.
- *Outcome:* the full final transcript is shown with timestamps and speaker labels, downloadable as plain text (`[timestamp] Speaker: utterance` per line — identical to the CLI's local transcript format).

**Story 4 — Bot fails to join, clear failure mode.**
- *Persona:* engineer pasting a link to a meeting that has not started, or a malformed URL.
- *Action:* pastes URL, clicks "Add to call".
- *Outcome:* the per-call page transitions to a terminal failure state (`COULD_NOT_JOIN` with the underlying Recall reason surfaced in plain English). No silent hang — terminal states are driven by Recall bot lifecycle events (`call_ended`, `bot_removed`, `fatal`), not by the absence of transcript traffic. "Try again" returns to dashboard.

**Story 5 — Mid-call tunnel/ingest outage is loud, never silent.**
- *Persona:* engineer watching a live transcript when the regional tunnel or webhook ingest degrades.
- *Action:* keeps the per-call page open.
- *Outcome:* within ≤ 2 probe intervals (default probe interval 20 s → banner visible within ≤ 40 s) a banner appears ("Transcript delivery degraded — recovering…") and a `SAMOGRAPH-WARNING: tunnel unreachable …` line is appended to the live transcript stream, mirroring the CLI's behavior. When ingest recovers a `SAMOGRAPH-WARNING: tunnel recovered` line is appended and the banner clears. The user is never silently shown an empty transcript while the bot is in the call.

**Story 6 — In-call recording disclosure (consent).**
- *Persona:* any participant in a call the samograph bot joins (not necessarily a samograph user).
- *Action:* the bot joins the call.
- *Outcome:* the bot's displayed participant name is `samograph (recording)` (recognizable bot identity) and the bot posts a single chat message on join ("samograph is recording this call's audio for the host's live transcript — samograph.dev"). Owner can see, but not suppress, the disclosure in v1.

### v2 stories (specified now to keep v1 architecture honest; **not built in v1**)

<!-- architecture:begin -->

```text
(architecture not yet specified)
```

<!-- architecture:end -->

**Story 7 — Mint a scoped AI-agent link for an active call.**
- *Persona:* AI-forward engineer in an active call who wants their Claude Code agent to listen + act.
- *Action:* on the per-call page, clicks "Connect AI agent", picks scopes (`listen`, `act:chat`, `act:frame`, `act:presence`, `act:leave`), TTL bounded by the call lifetime, clicks "Mint".
- *Outcome:* a one-time-display token + connection URL is shown. The agent uses it to call HTTP/WS or MCP endpoints. Every act-channel call is logged. "Revoke" kills the token immediately.

**Story 8 — AI agent acts in a call through the channel.**
- *Persona:* an external AI agent (Claude Code, Codex) authenticated with a minted token.
- *Action:* subscribes to the live transcript over WS, then posts a chat line, requests a screen-share frame, sets presence to `acting`.
- *Outcome:* the meeting chat shows the message (with the same chime as the CLI), the frame PNG is returned, the bot camera state changes. The agent can never see other tenants' data, never see the Recall token, and is rate-limited per token. All actions appear in the owner's audit log.

## 4. Architecture

### 4.1 Components and boundaries
```
           ┌────────────────────────────────────────┐
           │              samograph.dev             │
           │     (marketing + Next.js app shell)    │
           └──────────────┬─────────────────────────┘
                          │ HTTPS (magic-link auth, dashboard)
                          ▼
  ┌────────────────────────────────────────────────────────┐
  │  app-api (Bun/Hono)                                    │
  │   - /auth/magic-link  (request, callback)              │
  │   - /calls            (create from meeting URL)        │
  │   - /calls/:id/share  (mint/revoke read-only token)    │
  │   - /calls/:id/agent-token   [v2 stub in v1]           │
  │   - /audit            [v2; table exists in v1]         │
  └─────────┬─────────────────────────────┬────────────────┘
            │                             │
            │ enqueues join               │ issues per-call tokens
            ▼                             ▼
  ┌────────────────────────┐   ┌──────────────────────────┐
  │  bot-orchestrator      │   │  token-service           │
  │   - holds ONE shared   │   │   - per-call capability  │
  │     Recall API key     │   │     tokens (read/share/  │
  │   - creates Recall bot │   │     agent[v2])           │
  │   - registers call_id  │   │   - HMAC-signed, KID     │
  │     with ingest        │   │     rotated, revocable   │
  │   - registers bot-     │   │   - ingest_secret per    │
  │     worker address in  │   │     call (separate from  │
  │     workers table      │   │     user-visible tokens) │
  └─────────┬──────────────┘   └──────────────────────────┘
            │ POST recall.ai with webhook_url=
            │   <regional-tunnel>/webhook?bot=<id>&t=<ingest_secret>
            ▼
  ┌────────────────────────────────────────────────────────┐
  │  Recall.ai (Zoom / Google Meet)                        │
  └─────────┬──────────────────────────────────────────────┘
            │ webhooks (signed) + WSS video frames
            ▼
  ┌────────────────────────────────────────────────────────┐
  │  Regional ingress  (one PERSISTENT cloudflared NAMED   │
  │  tunnel per region — NOT one tunnel per call)          │
  └─────────┬──────────────────────────────────────────────┘
            │ HTTPS/WSS
            ▼
  ┌────────────────────────────────────────────────────────┐
  │  ingest (Bun/Hono)                                     │
  │   - POST /webhook?bot=...&t=...                        │
  │   - GET  /health  (tunnel round-trip marker)           │
  │   - verifies Recall webhook signature                  │
  │   - verifies ingest_secret matches calls.ingest_secret │
  │     for bot_id, in constant time                       │
  │   - tenancy gate: bot_id → call → tenant               │
  │   - normalizer → transcript lines                      │
  │   - lifecycle events drive call status transitions     │
  │   - persists to Postgres                               │
  │   - publishes to fan-out hub                           │
  │   - leader election (per region) for watchdog          │
  └─────────┬──────────────────────────────────────────────┘
            │ pub/sub (per-call channel)
            ▼
  ┌────────────────────────────────────────────────────────┐
  │  ws-hub                                                │
  │   - /calls/:id/stream  (live transcript)               │
  │   - bounded per-conn outbound queue + backpressure     │
  │   - auth: owner cookie OR share token OR agent token   │
  │     [v2: agent scope checks act vs listen]             │
  │   - no in-process token cache (one DB hit per upgrade) │
  └─────────┬──────────────────────────────────────────────┘
            │ WSS
            ▼
  ┌────────────────────────────────────────────────────────┐
  │  per-call page (Next.js)                               │
  │   - live transcript stream, share button, status,      │
  │     tunnel-degraded banner                             │
  └────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────┐
  │  bot-worker (process-per-call command surface)         │
  │   - exposes chat/frame/frames/presence/leave           │
  │   - listens on a host:port registered in `workers`     │
  │     table at start (host, port, call_id, secret)       │
  │   - app-api / agent-gateway resolve worker via         │
  │     workers table; authenticate with per-worker        │
  │     shared secret (mTLS within VPC in production)      │
  │   - in v1 invoked only by app-api on owner actions     │
  │   - in v2 invoked by AI-agent channel via token-svc    │
  │   - same code path; capability scopes gate it          │
  └────────────────────────────────────────────────────────┘

  Postgres (single multi-tenant DB, RLS-enforced per tenant)
    users, calls, transcripts (append-only),
    tokens (call_id, scopes, ttl, revoked_at, KID),
    audit_log (call_id, actor, action, payload-hash, ts),
    workers (call_id, host, port, worker_secret_hash),
    regions (tunnel_hostname, status, leader_id, ...)
```

### 4.2 Key abstractions (preserved across v1 → v2)
- **`Call`** — `(id, tenant_id, recall_bot_id, meeting_url, region, status, created_at, ended_at, ingest_secret_hash)`.
- **`CapabilityToken`** — `(id, call_id, scopes[], ttl, revoked_at, kid)`. v1 uses two distinct scopes (defined in §5.6). v2 adds `act:chat | act:frame | act:presence | act:leave`. The same verifier handles all of them.
- **`IngestSecret`** — a per-call, server-side-only secret encoded in the Recall webhook URL as `?t=…`. Not a `CapabilityToken`; never user-visible; never returned by any API. Stored as a SHA-256 hash in `calls.ingest_secret_hash` and verified in constant time on every webhook POST. Survives the full call lifetime (so it CANNOT be "one-time" — Recall posts many webhooks per call) and is invalidated when the call enters a terminal state.
- **`TranscriptLine`** — append-only `(call_id, seq, ts, speaker, text)`. The normalizer turns Recall transcript events into this canonical shape.
- **`AuditEvent`** — written on every privileged action (mint token, revoke, bot create/leave, share mint/revoke; v2: every act-channel call).
- **`Tenancy gate`** — single helper used by every authenticated route + WS upgrade: `(token | session) → tenant_id → call_id ∈ tenant_id`.
- **`Worker registration`** — on start, bot-worker writes `(call_id, host, port, worker_secret_hash)` to `workers`; app-api/agent-gateway look up by `call_id` and authenticate the inter-service call with the per-worker secret (and mTLS in prod). Provides service discovery so the "same code path" claim (§5.7) is real, not aspirational.

### 4.3 Why one named regional tunnel, not one tunnel per call
The CLI's per-call ngrok model does not scale and is the single largest contributor to mid-call failure (the existing `ERR_NGROK_727` story). One persistent cloudflared **named** tunnel per region gives a stable DNS hostname, no per-call provisioning latency, and one shared health surface. Per-call routing is encoded in the webhook URL (`?bot=<id>&t=<ingest_secret>`) and verified at the tenancy gate. The mid-call watchdog (§4.5) runs once per region, not once per ingest replica (see leader election, §4.6).

### 4.4 Why a shared Recall API key (and the boundary that makes it safe)
A single Recall key in a secret manager is the only practical v1 model (Recall does not give per-tenant child keys at our scale). Tenant isolation is therefore enforced **above** Recall: (a) the key only exists in the bot-orchestrator and ingest processes; (b) every request that names a `bot_id` passes through the tenancy gate before any Recall call; (c) the AI-agent channel in v2 is mediated by token-service + bot-worker — the agent never holds or sees the Recall key; (d) the audit log captures every Recall-mediated action; (e) the webhook authenticity check (Recall signature + `ingest_secret`) prevents external spoofing of `?bot=<victim>` (§5.3, §6.2 #7).

### 4.5 Tunnel watchdog (server-side analog of the CLI watchdog)
Ingest runs a per-region watchdog that probes `https://<regional-tunnel>/health?nonce=…` with a one-time nonce and the same `samograph-health` marker the CLI already uses (`src/server.ts:HEALTH_MARKER`). **Default probe interval = 20 s.** Two consecutive failures flip the region to `degraded`, which (a) appends `SAMOGRAPH-WARNING: tunnel unreachable …` to every active call's live transcript stream in that region and (b) raises the dashboard banner. Recovery appends `SAMOGRAPH-WARNING: tunnel recovered` and clears the banner.

### 4.6 Watchdog leader election (replica-safe "exactly once")
Ingest scales horizontally. To preserve "exactly one warning line per outage" across replicas, the watchdog runs only on the **leader** for a region. Leader election uses a Postgres advisory lock keyed on `region_id` with a 60 s lease (renewed every 20 s; expires automatically if the leader dies). Only the leader writes to `regions.status`, only the leader emits warning/recovery lines. Followers run no probes. Tested explicitly under concurrent replicas (§6.2 #5).

### 4.7 Region selection policy
v1 ships a single region (`us-east`). When a second region is added (Sprint 3 / v1.1), `calls.region` is set at orchestrator time by: (a) user-pinned override if present, else (b) lowest-latency healthy region for the orchestrator host (round-robin within ties). A region marked `degraded` fails **closed** for new calls (orchestrator skips it) and the chosen alternative is logged. Already-IN_CALL calls in a degraded region are not migrated (Recall does not support cross-region bot migration); they continue to surface the warning until recovery.

## 5. Implementation details

### 5.1 Auth (magic link)
- `POST /auth/magic-link {email}` → server creates a one-time, single-use, 15-minute token, signs it (HMAC + KID), sends an email via a transactional provider (Postmark or Resend).
- `GET /auth/callback?token=…` → verifies in **constant time**, marks the token consumed (idempotent, replay-safe), creates/loads user, sets a signed session cookie (HttpOnly, Secure, SameSite=Lax). A second use of a consumed token returns 401 with no body.
- Concurrent outstanding links per email: the most recently issued link supersedes prior ones (older outstanding tokens are invalidated server-side at issue time).
- Rate limits, expressed as separate counters (whichever fires first blocks):
  - **per-email**: 5 requests / hour.
  - **per-IP**: 20 requests / hour.
  - The previous "AND" phrasing is replaced by these explicit independent limits.
- Deliverability: SPF + DKIM + DMARC on `samograph.dev` from day one (corporate mail will silently drop us otherwise — §10).
- KID rotation: rotated every 90 days; both current and previous KIDs are accepted during a 30-day overlap window.

### 5.2 Call lifecycle
Driven by Recall bot lifecycle events, NOT by transcript traffic. A silent call must still transition to `IN_CALL`.

```
user pastes URL
  → app-api validates (must be a known Zoom / Google Meet URL pattern)
  → app-api creates Call (status=PENDING) in DB
  → app-api enqueues bot-orchestrator job (call_id)
  → orchestrator picks region per §4.7, generates ingest_secret,
    stores ingest_secret_hash on Call, calls Recall createBot with
       webhook_url = https://<region-tunnel>/webhook?bot=<bot_id>&t=<ingest_secret>
    and pre-mints per-call read/share tokens
  → status=JOINING (set on Recall ack of createBot — SLO ≤ 5 s of submit)
  → status=IN_CALL on Recall bot lifecycle event
       `in_call_recording` OR `in_call_not_recording`
    (NOT first transcript line — guarantees silent calls progress)
  → status=ENDED on Recall `call_ended` OR owner "leave" verb
  → status=COULD_NOT_JOIN on Recall `fatal` / non-recoverable failure;
    on owner "Try again" a new Call row is created.
  → status=BOT_REMOVED on Recall `bot_removed`
  → status=INGEST_DEGRADED is a soft state on Call (overlay; does not end the call)
```
First-line latency is still recorded (`first_line_at`) for the activation funnel (§9) but is no longer the trigger for `IN_CALL`.

### 5.3 Webhook ingest authenticity
Every `POST /webhook?bot=…&t=…` to ingest is validated in this order, all failures returning 401 with no body and logging once at WARN:
1. **Recall webhook signature** verified against Recall's published HMAC scheme (and a per-region webhook secret in secret manager). Rejects external spoofs that never went through Recall.
2. **`bot` query param** is a known `recall_bot_id` in `calls`.
3. **`t` query param** matches `calls.ingest_secret_hash` for that `bot_id`, compared in **constant time**.
4. **Tenancy gate** resolves `bot_id → tenant_id`; subsequent writes set `app.tenant_id` for RLS.
The `?t=` value is the IngestSecret defined in §4.2 — long-lived for the call, server-side-only, never user-visible, never a `CapabilityToken`. Adversarial test coverage: §6.2 #7.

### 5.4 Transcript normalizer
Reuses `formatTranscriptLine` semantics from `src/transcript.ts` so the wire/disk format is byte-identical to the CLI. Inputs: Recall `transcript.data` payloads (varying word/partial shapes seen historically). Output: canonical `[YYYY-MM-DD HH:MM:SS] Speaker: utterance\n`. Pure function, no I/O, fed by the webhook handler. **TDD-built** (§6.2 #1).

### 5.5 WS fan-out + backpressure
- One in-process pub/sub channel per `call_id`.
- Each subscriber has a bounded outbound queue, capped by two independent limits — **whichever fires first triggers overflow**: **256 messages** OR **512 KB** outstanding.
- Overflow policy: **drop oldest**, increment `ws_dropped_total{call_id}`, send a single `{type:"gap", since_seq, until_seq}` control frame so the client can request a backfill via REST.
- Slow client never blocks other subscribers in the same channel. **Publisher-side latency SLO under one stalled subscriber at queue-full: p99 ≤ 5 ms / message** (asserted in tests, §6.2 #3).
- Reconnect carries `?since_seq=…` for replay from Postgres.
- No in-process token cache on the hot path; one DB lookup per WS upgrade (revoke-within-1s SLO depends on this — §6.2 #4). If a cache is ever added, a cache-invalidation test must land in the same PR.
- **TDD-built** (§6.2 #3).

### 5.6 Tenant-isolation authorization gate
A single function `authorizeCall(req) → { tenantId, callId, scopes }` is the only entry point. Every route, every WS upgrade, every bot-worker invocation calls it before touching state. Inputs accepted: session cookie, share token, [v2] agent token. Failure modes return 403 with no body. No code path may reach Recall without going through this gate. **TDD-built**, with adversarial cases (cross-tenant `call_id`, expired token, revoked token, token re-use across tenants) — §6.2 #4.

### 5.7 Capability tokens (v1 scopes)
- HMAC-SHA256 with a server secret, KID in the payload, JSON body `{kid, call_id, scopes[], iat, exp, jti}`.
- Always verified constant-time.
- Persisted in `tokens` table so revoke is O(1) on the server. **No verifier-side caching in v1** (§5.5).
- `jti` is enforced as unique to prevent replay across rotations.
- KID rotation cadence: 90 days, with 30 days of overlap (same policy as §5.1).
- v1 scopes — concretely distinct, not synonyms:
  - **`read`** — bound to an **authenticated owner session** for a `call_id`. Issued implicitly on owner navigation, lives for the session. Higher per-connection WS rate limit. Not revocable independently (revoked by signing out / session expiry). Audit entries attribute the actor as `user:<id>`.
  - **`share`** — bound to a **public, anonymous URL**. Issued explicitly by the owner via "Share". Owner-revocable at any time (one-click). Lower per-connection WS rate limit and a per-token concurrent-connection cap. Audit entries attribute the actor as `share:<token-id>`. Read-only HTML page hides all owner-only controls.
- v2 adds: `act:chat | act:frame | act:presence | act:leave`. Same generator, same verifier, just scoped strings.
- **TDD-built** (§6.2 #2).

### 5.8 Bot-worker command/act API (v1 seam for v2)
The bot-worker process per call exposes an HTTP surface bound to a registered `host:port`:
- `POST /v1/call/:id/chat {message}`
- `POST /v1/call/:id/presence {state, message?}`
- `GET  /v1/call/:id/frames`
- `GET  /v1/call/:id/frame?source=…`
- `POST /v1/call/:id/leave`
**Service discovery + auth.** On start, bot-worker generates a per-instance secret, writes `(call_id, host, port, worker_secret_hash)` to the `workers` table, and binds to a private network interface. app-api (v1) and agent-gateway (v2) resolve the worker by querying `workers` for `call_id`, then call it with the per-instance secret in an `Authorization: Bearer` header. In production the call is also mTLS (VPC-internal CA). In dev the worker binds to loopback and the secret alone authenticates. **No new bot-worker work in v2** other than wiring the agent gateway to it.

### 5.9 In-call recording disclosure (consent)
- Bot's Recall display name is `samograph (recording)` in v1. Cannot be customized.
- On `in_call_recording` / `in_call_not_recording`, bot-worker posts ONE chat line: `"samograph is recording this call's audio for the host's live transcript — samograph.dev"`.
- The disclosure post is non-suppressible in v1 (owner cannot disable it). Future per-jurisdiction tuning is deferred.
- This is the in-call leg of the two-party-consent mitigation; the dashboard-side disclosure (§10 #4) remains for the host.

### 5.10 Data model (Postgres, RLS-enforced)
```
users          (id, email, created_at)
tenants        (id, owner_user_id, created_at)              -- 1:1 with user in v1
calls          (id, tenant_id, recall_bot_id, meeting_url,
                region, status, created_at, ended_at,
                first_line_at, ingest_secret_hash)
transcripts    (call_id, seq, ts, speaker, text)            -- append-only, PK (call_id, seq)
tokens         (id, call_id, scopes text[], kid, jti,
                expires_at, revoked_at)
audit_log      (id, tenant_id, call_id, actor, action,
                payload_sha256, ts)
workers        (call_id PK, host, port, worker_secret_hash,
                registered_at, last_heartbeat_at)
regions        (id, tunnel_hostname, status, last_probe_ts,
                leader_id, leader_lease_expires_at)
```
RLS policy: every table that has `tenant_id` (directly or via `call_id`) is filtered by `tenant_id = current_setting('app.tenant_id')`. The tenancy gate is the only thing that sets that setting. `workers` is RLS-filtered by joining `calls.tenant_id`.

### 5.11 Observability (v1, minimum bar)
- Structured logs (JSON) with `call_id`, `tenant_id`, `region`.
- Counters: `bot_join_total{result}`, `transcript_lines_total{region}`, `ws_dropped_total{call_id}`, `tunnel_probe_failed_total{region}`, `webhook_rejected_total{reason}`.
- A single "activation funnel" dashboard: signup → magic-link clicked → call created → first transcript line → 30s of stream. This IS the v1 success metric (§9).

## 6. Tests plan

### 6.1 CI baseline
- `bun test` (existing harness) + `bunx tsc --noEmit` clean on every PR (same merge gate the repo already enforces, see CLAUDE.md). Adds new packages under `apps/web`, `apps/app-api`, `apps/ingest`, `apps/ws-hub`, `apps/bot-worker`, `packages/shared`.
- Postgres-backed integration tests run against an ephemeral container (no mocks — keep parity with prod migrations).
- CI smoke test: **uses a deterministic in-repo Recall fake** (`packages/test-fakes/recall`) on every PR. A separate **nightly** job runs the same scenario against the real Recall sandbox endpoint. The "or" from v0.1 is replaced by this concrete split.

### 6.2 Red/green TDD list (write tests first; these are the subtle pieces)
1. **Transcript normalizer** (`packages/shared/transcript`). Inputs: a corpus of real Recall `transcript.data` shapes captured from the CLI's history; outputs: canonical lines. Red cases first — empty words array, partial vs final, missing speaker, Unicode, very long utterance, timestamp drift. Property test: same input → same output, idempotent across reorderings of words within a single utterance event.
2. **Capability token generator/verifier** (`packages/shared/tokens`). Red cases: wrong KID, expired, revoked, scope mismatch (request asks for `act:chat`, token holds only `read`), jti replay, tampered payload, timing-attack resistance (always constant-time compare). Green: round-trip for every scope combination, including the explicit `read` vs `share` distinction (different rate limits, different audit actor attribution).
3. **WS fan-out backpressure** (`apps/ws-hub`). Red cases: with one subscriber stalled at queue-full, **publisher-side per-message latency p99 ≤ 5 ms** (the bound is explicit and asserted, not handwaved); overflow must drop oldest and emit a single gap control frame; reconnect with `?since_seq` must produce exact missing range from Postgres; isolation across `call_id` channels; queue cap hits at min(256 msgs, 512 KB).
4. **Tenant-isolation authorization gate** (`packages/shared/auth`). Adversarial cases: tenant A's share-token used to subscribe to tenant B's call → 403; expired token → 403; revoked token → 403 within 1 s of revoke (asserted **without** any verifier-side cache; if cache is added later, this test gains an invalidation case in the same PR); token bound to call X used on call Y → 403; no token, no session → 403; session present but `call_id` not in tenant → 403. Plus a fuzz round (random payloads must never return 2xx).
5. **Multi-call tunnel watchdog (with leader election)** (`apps/ingest`). Red cases: single-process — 2 consecutive failed probes flips region to degraded; warning line appended to every IN_CALL transcript in that region; recovery appends exactly one recovered line; flapping (fail-pass-fail) does not spam. **Distributed** — 3 ingest replicas race for the advisory lock; only one runs the watchdog; on leader-kill the next replica takes over within ≤ lease + probe interval; warning/recovery lines are emitted exactly once per outage across the cluster.
6. **Magic-link security** (`apps/app-api`). Red cases: token replay after `/auth/callback` consumes it → 401; token used after 15-min TTL elapses (including "clicked at 14:59, consumed at 15:01") → 401; timing-safe comparison on `/auth/callback` (statistical timing test); two concurrent outstanding links for one email — the older is invalidated server-side at issue time, only the newest verifies; per-email rate limit (5/hr) and per-IP rate limit (20/hr) trip independently; tampered KID → 401; signature mismatch → 401.
7. **Webhook authenticity (ingest)** (`apps/ingest`). Adversarial cases: external POST with valid-looking `?bot=<known>&t=<guessed>` but no/invalid Recall signature → 401; valid Recall signature but `?t=` mismatched against `calls.ingest_secret_hash` → 401; valid signature + valid `?t=` but `bot_id` belongs to a tenant the request claims a different `call_id` for → 403 (tenancy gate); replay of a valid webhook body — accepted at most once (Recall delivers at-least-once; we are idempotent via `(bot_id, recall_event_id)`); fuzz of malformed payloads must never reach the normalizer with a partially-valid state.
8. **Bot lifecycle → call status** (`apps/ingest`). Red cases: a silent call (no transcript events for 60 s after bot admission) still reaches `IN_CALL` solely on Recall lifecycle; `BOT_REMOVED` while previously `IN_CALL` ends the call cleanly with the right audit entry; `fatal` before `JOINING` produces `COULD_NOT_JOIN` with the Recall reason string surfaced.
9. **Worker registration / discovery** (`apps/bot-worker` + `apps/app-api`). Red cases: app-api can resolve a worker by `call_id` only for calls in its tenant (RLS-filtered); a stale `workers` row whose process is dead returns a connection error that surfaces as a clean 503 to the dashboard (not a hang); per-worker secret mismatch → 401; calls into another tenant's worker via a leaked secret → 403 (tenancy gate runs before the inter-service auth).

### 6.3 Manual test plan (mirrors §3 stories)
A scripted run-through per story, executed by the team on a staging tenant, recorded as the v0.2 acceptance gate. Story 6 (in-call disclosure) is verified by joining a real test Zoom/Meet and confirming the bot's display name and the on-join chat post.

## 7. Team (veteran experts to hire)

- **Veteran real-time meeting infrastructure engineer (1)** — Recall.ai integration, bot lifecycle, transcript ingest, regional cloudflared named tunnels, watchdog (incl. leader election). *Lead engineer for the call path.*
- **Veteran backend / API engineer (1)** — app-api, Postgres schema + RLS, token service, capability model, audit log, worker registration.
- **Veteran security engineer (1, fractional/0.5 in v1, full in v2)** — tenancy gate threat model, magic-link flow review, webhook authenticity (Recall signature + ingest_secret), capability-token design, AI-agent channel design review for v2.
- **Veteran full-stack / Next.js engineer (1)** — marketing site, dashboard, per-call page, WS client, share-link page, degraded-banner UX.
- **Veteran SRE / platform engineer (1)** — Postgres + secret manager + one-region-then-multi-region deploy, cloudflared named-tunnel ops, advisory-lock leader election, on-call playbook, observability dashboards.
- **Veteran product designer (0.5)** — exactly the dashboard + per-call page + share modal; deliberately tiny scope to keep v1 small.

Total: 4.5 FTE in v1; +0.5 security in v2; product designer rolls off after v1.

## 8. Implementation plan (sprints, parallelization, ordering)

v1 target: **one week**, three sprints of ~2 days each. Sprints overlap heavily — work is parallelized by track, not gated end-to-end.

### Sprint 1 (Days 1–2) — "the seams"
Parallel tracks:
- **Backend (API engineer)** — Postgres schema + migrations (users, tenants, calls, transcripts, tokens, audit_log, workers, regions) with RLS. App-api skeleton: `/auth/magic-link`, `/auth/callback`, `/calls` (create + read). **TDD** token generator/verifier (§6.2 #2). **TDD** tenancy gate (§6.2 #4). **TDD** magic-link security (§6.2 #6).
- **Call-path (meeting infra engineer)** — `packages/shared/transcript` normalizer extracted from CLI, **TDD** (§6.2 #1). Bot-orchestrator skeleton; reuse `src/recall.ts` client; integrate with shared Recall key from secret manager; ingest_secret generation. Stand up first regional cloudflared named tunnel.
- **SRE** — Provision Postgres (managed), secret manager (Recall key + Recall webhook secret + email provider key + KID secret + region webhook secrets), one region's cloudflared named tunnel, CI matrix update.
- **Frontend (full-stack)** — Marketing landing at `samograph.dev`. Magic-link request + callback pages. Dashboard skeleton.
- **Security (fractional)** — Threat model for the tenancy gate; review token shape and KID rotation plan before code lands; review webhook authenticity design (Recall signature + ingest_secret).

*Sprint exit:* a signed-in user can create a `Call` row from a URL; tokens round-trip; tenancy gate has full adversarial test coverage; magic-link security tests pass; one regional tunnel passes the `/health` round-trip.

### Sprint 2 (Days 3–5) — "the live transcript"
Parallel tracks:
- **Call-path** — Ingest service receives Recall webhooks, **verifies Recall signature + ingest_secret** (§5.3), runs normalizer, writes to `transcripts`, publishes to fan-out hub. **TDD** webhook authenticity (§6.2 #7). **TDD** bot lifecycle → call status (§6.2 #8). Multi-call tunnel watchdog with Postgres advisory-lock leader election, **TDD** (§6.2 #5). Bot-worker command/act API + worker registration, **TDD** (§6.2 #9). In-call disclosure chat post on `in_call_recording`.
- **Backend** — WS hub (`/calls/:id/stream`) with bounded queues + backpressure + gap frames + `?since_seq` replay from Postgres + **publisher-latency SLO assertion**, **TDD** (§6.2 #3). Share-link mint/revoke endpoints + `share` scope wiring (distinct from `read`). Audit-log writes for bot create/leave, share mint/revoke.
- **Frontend** — Per-call page: live WS, status states driven by Recall lifecycle (JOINING / IN_CALL / ENDED / COULD_NOT_JOIN / BOT_REMOVED), degraded banner driven by warning lines, share modal.
- **SRE** — Activation-funnel dashboard wired to log counters; on-call playbook draft for `INGEST_DEGRADED` and `COULD_NOT_JOIN`; advisory-lock leader-election runbook.

*Sprint exit:* end-to-end happy path works against a real Recall bot on a real Zoom/Meet call; silent-call test reaches `IN_CALL`; share link works and revokes within 1 s; a forced tunnel outage in staging produces the warning line and clears it on recovery; bot disclosure visible in real call.

### Sprint 3 (Days 6–7) — "harden + ship"
Parallel tracks:
- **All** — Manual test pass of §3 stories on staging (including Story 6 disclosure).
- **Call-path + SRE** — Add a second region behind the same regional-tunnel pattern (proves the multi-region seam without making it required for ship). Region selection policy (§4.7) wired up.
- **Backend + Security** — Rate-limit magic-link (5/hr/email, 20/hr/IP, independent), rate-limit bot creation per tenant, rate-limit WS connections per call (distinct caps for `read` vs `share`). Final review of tenancy gate, token verifier, webhook authenticity, RLS policies. Magic-link deliverability check against Gmail + at least one corporate mail (SPF/DKIM/DMARC live).
- **Frontend** — Past-calls list, transcript download, terminal failure UX, empty/loading states. Final marketing copy.

*Sprint exit:* the v1 acceptance test (§3 stories + W1 activation metric instrumented) passes on staging; deploy to prod behind a public URL.

### Phase 2 (next, not this week)
A single follow-on sprint adds: agent gateway (HTTP + WS + MCP), `act:*` scopes in the token verifier, per-token rate limits, agent-channel audit-log entries on every act call, dashboard "Connect AI agent" affordance with scope-picker + one-click revoke. Because the bot-worker command/act API, the worker-registration discovery model, and the capability-token model already exist, this should be days, not weeks.

## 9. Success metric

**v1 (single metric):** W1 activation = fraction of new signups who, within their first week, (a) paste a meeting link, (b) get the bot admitted into a real call (Recall lifecycle reaches `in_call_*`, not first transcript line), (c) and watch ≥30 s of live transcript stream on the per-call page. **Target ≥ 0.5.** Instrumented from the activation funnel dashboard (§5.11). This is the only number we optimize in v1.

**v2 (later, do not optimize in v1):** number of active calls with at least one AI-agent connection through the bidirectional channel.

## 10. Open questions / risks

1. **Shared Recall API key — tenant isolation.** Mitigation: the key never leaves bot-orchestrator + ingest; every request flows through the tenancy gate; audit log captures every Recall-mediated action; pen-test the gate before v2 launches the agent channel.
2. **AI-agent channel security (v2).** Capability-scoped, short-TTL, revocable tokens; rate-limited; full audit; never expose Recall key. Requires explicit security review before v2 ships.
3. **Act-channel abuse (v2).** An agent posting in someone's meeting / grabbing frames must be authorized, logged, and revocable. Per-token rate limits + per-tenant daily caps.
4. **Consent / recording disclosure across two-party-consent jurisdictions.** Addressed at three layers: (a) host-side dashboard disclosure; (b) bot display name `samograph (recording)` visible to all participants; (c) bot posts a single in-call chat disclosure on `in_call_recording` (§5.9). Legal sign-off still needed before broad launch; not blocking the build-week.
5. **Recall.ai cost guardrails and free-tier limits.** Per-tenant active-call cap + per-tenant minutes/day cap in v1, conservative defaults, surfaced as a friendly error rather than a silent failure.
6. **Tunnel as single point of failure.** One regional named tunnel per region; watchdog with loud warnings; leader-elected so warnings are not multiplied by ingest replica count; multi-region seam built in Sprint 3.
7. **Magic-link deliverability on corporate mail.** SPF/DKIM/DMARC from day one; warm IP via the transactional provider; explicit "didn't get it?" affordance with re-send + alternate-email entry. Tracked as a launch blocker.
8. **Regional named-tunnel ops.** cloudflared named tunnels require credentials + DNS — captured in the SRE on-call playbook.
9. **MCP endpoint shape for v2.** Spec'd in v2's design doc; v1 only needs the bot-worker command/act API to be MCP-compatible in payload shape (verbs are 1:1 with CLI).
10. **WS reconnect storms.** Bounded queues + `?since_seq` replay mean reconnect is cheap; per-IP connection cap on ws-hub as a safety belt.
11. **Worker process crash mid-call.** v1 surfaces a 503 to the dashboard on owner-action; transcript ingest is independent of bot-worker and keeps flowing. Auto-restart + workers-table reconciliation deferred to v1.1 unless it bites during build-week.

## 11. Changelog (embedded; mirrors changelog.md)

- **v0.2 (2026-06-23)** — Addressed Reviewer B v0.1 findings. Removed the stale `<!-- architecture:begin -->` placeholder in §3. Made the `read` vs `share` scope distinction concrete (session-bound vs anonymous-link; distinct rate limits, revocation paths, audit attribution). Introduced the `IngestSecret` abstraction and §5.3 webhook authenticity flow (Recall signature + constant-time secret match) — separates the long-lived per-call ingest secret from user-visible `CapabilityToken`s. Added bot-worker service discovery via a `workers` table + per-instance secret (mTLS in prod). Moved `JOINING → IN_CALL` onto Recall bot-lifecycle events so silent calls progress. Pinned numeric defaults (probe interval 20 s; magic-link 5/hr/email + 20/hr/IP independent; queue 256 msgs OR 512 KB; KID 90-day rotation with 30-day overlap). Added explicit publisher-latency SLO (p99 ≤ 5 ms with stalled subscriber) to §5.5 + §6.2 #3. Added watchdog leader election via Postgres advisory lock (§4.6) and distributed-replica test coverage. Added §6.2 #6 magic-link security tests, §6.2 #7 webhook authenticity tests, §6.2 #8 bot-lifecycle status tests, §6.2 #9 worker discovery tests. Committed CI smoke test to in-repo Recall fake + nightly real-Recall job. Committed to no verifier-side token cache in v1. Added §5.9 in-call disclosure (bot name + chat post on join) to address two-party-consent at the participant level. Added §4.7 region selection policy. Qualified Story 1 SLOs.
- **v0.1 (2026-06-23)** — Initial draft. Two-phase scope (v1 zero-setup hosted samograph; v2 secure bidirectional AI-agent channel). Architecture with shared Recall key + regional named cloudflared tunnels + tenancy gate + capability tokens + audit log; v2 seams (bot-worker command/act API, capability-scoped tokens) wired in v1. TDD list for transcript normalizer, capability tokens, WS backpressure, tenancy gate, multi-call tunnel watchdog. 4.5-FTE team, three-sprint one-week plan. W1 activation ≥ 0.5 as the single v1 metric.
