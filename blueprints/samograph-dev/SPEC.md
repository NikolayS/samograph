# samograph.dev — SPEC v0.1

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
- *Outcome:* within ~10 s the per-call page opens with status "Joining…", then "In call". Transcript lines start streaming live. Closing and re-opening the tab resumes without loss. After the call ends, the full transcript remains in the dashboard.

**Story 2 — Share the live transcript read-only.**
- *Persona:* same engineer (or a non-signed-in colleague / participant with hard-to-understand accent / multilingual viewer).
- *Action:* on the per-call page, owner clicks "Share" → gets a signed read-only URL → sends it to a teammate.
- *Outcome:* recipient opens the URL without signing in and sees the live transcript stream in real time, read-only (no controls to leave, mint AI tokens, or see other calls). The link is revocable from the owner's dashboard and stops working immediately on revoke.

**Story 3 — Durable transcript after Recall's video TTL.**
- *Persona:* engineer reviewing a meeting 10 days later (past Recall's ~7-day video retention).
- *Action:* opens dashboard → "Past calls" → selects the call.
- *Outcome:* the full final transcript is shown with timestamps and speaker labels, downloadable as plain text (`[timestamp] Speaker: utterance` per line — identical to the CLI's local transcript format).

**Story 4 — Bot fails to join, clear failure mode.**
- *Persona:* engineer pasting a link to a meeting that has not started, or a malformed URL.
- *Action:* pastes URL, clicks "Add to call".
- *Outcome:* the per-call page transitions to a terminal failure state (`COULD_NOT_JOIN` with the underlying Recall reason surfaced in plain English). No silent hang. "Try again" returns to dashboard.

**Story 5 — Mid-call tunnel/ingest outage is loud, never silent.**
- *Persona:* engineer watching a live transcript when the regional tunnel or webhook ingest degrades.
- *Action:* keeps the per-call page open.
- *Outcome:* within ≤2 probe intervals a banner appears ("Transcript delivery degraded — recovering…") and a `SAMOGRAPH-WARNING: tunnel unreachable …` line is appended to the live transcript stream, mirroring the CLI's behavior. When ingest recovers a `SAMOGRAPH-WARNING: tunnel recovered` line is appended and the banner clears. The user is never silently shown an empty transcript while the bot is in the call.

### v2 stories (specified now to keep v1 architecture honest; **not built in v1**)

<!-- architecture:begin -->

```text
(architecture not yet specified)
```

<!-- architecture:end -->

**Story 6 — Mint a scoped AI-agent link for an active call.**
- *Persona:* AI-forward engineer in an active call who wants their Claude Code agent to listen + act.
- *Action:* on the per-call page, clicks "Connect AI agent", picks scopes (`listen`, `act:chat`, `act:frame`, `act:presence`, `act:leave`), TTL bounded by the call lifetime, clicks "Mint".
- *Outcome:* a one-time-display token + connection URL is shown. The agent uses it to call HTTP/WS or MCP endpoints. Every act-channel call is logged. "Revoke" kills the token immediately.

**Story 7 — AI agent acts in a call through the channel.**
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
  └─────────┬──────────────┘   └──────────────────────────┘
            │ POST recall.ai with webhook_url=
            │   <regional-tunnel>/webhook?bot=<id>&t=<one-time>
            ▼
  ┌────────────────────────────────────────────────────────┐
  │  Recall.ai (Zoom / Google Meet)                        │
  └─────────┬──────────────────────────────────────────────┘
            │ webhooks + WSS video frames
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
  │   - tenancy gate: bot_id → call → tenant               │
  │   - normalizer → transcript lines                      │
  │   - persists to Postgres                               │
  │   - publishes to fan-out hub                           │
  └─────────┬──────────────────────────────────────────────┘
            │ pub/sub (per-call channel)
            ▼
  ┌────────────────────────────────────────────────────────┐
  │  ws-hub                                                │
  │   - /calls/:id/stream  (live transcript)               │
  │   - bounded per-conn outbound queue + backpressure     │
  │   - auth: owner cookie OR share token OR agent token   │
  │     [v2: agent scope checks act vs listen]             │
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
  │   - in v1 invoked only by app-api on owner actions     │
  │   - in v2 invoked by AI-agent channel via token-svc    │
  │   - same code path; capability scopes gate it          │
  └────────────────────────────────────────────────────────┘

  Postgres (single multi-tenant DB, RLS-enforced per tenant)
    users, calls, transcripts (append-only),
    tokens (call_id, scopes, ttl, revoked_at, KID),
    audit_log (call_id, actor, action, payload-hash, ts)
```

### 4.2 Key abstractions (preserved across v1 → v2)
- **`Call`** — `(id, tenant_id, recall_bot_id, meeting_url, region, status, created_at, ended_at)`.
- **`CapabilityToken`** — `(id, call_id, scopes[], ttl, revoked_at, kid)`. v1 uses `read`/`share`. v2 adds `act:chat | act:frame | act:presence | act:leave`. The same verifier handles all of them.
- **`TranscriptLine`** — append-only `(call_id, seq, ts, speaker, text)`. The normalizer turns Recall transcript events into this canonical shape. Same shape on disk, in the fan-out hub, and in the API response.
- **`AuditEvent`** — written on every privileged action (mint token, revoke, [v2] every act-channel call). v1 records: token mint/revoke, bot create/leave, share-link mint/revoke. v2 adds: every agent act.
- **`Tenancy gate`** — single helper used by every authenticated route + WS upgrade: `(token | session) → tenant_id → call_id ∈ tenant_id`. There is no other way to authorize a call.

### 4.3 Why one named regional tunnel, not one tunnel per call
The CLI's per-call ngrok model does not scale and is the single largest contributor to mid-call failure (the existing `ERR_NGROK_727` story). One persistent cloudflared **named** tunnel per region gives a stable DNS hostname, no per-call provisioning latency, and one shared health surface. Per-call routing is encoded in the webhook URL (`?bot=<id>&t=<one-time>`) and verified at the tenancy gate. The mid-call watchdog (Section 4.5) runs against the regional tunnel, not per call.

### 4.4 Why a shared Recall API key (and the boundary that makes it safe)
A single Recall key in a secret manager is the only practical v1 model (Recall does not give per-tenant child keys at our scale). Tenant isolation is therefore enforced **above** Recall: (a) the key only exists in the bot-orchestrator and ingest processes; (b) every request that names a `bot_id` passes through the tenancy gate before any Recall call; (c) the AI-agent channel in v2 is mediated by token-service + bot-worker — the agent never holds or sees the Recall key; (d) the audit log captures every Recall-mediated action.

### 4.5 Tunnel watchdog (server-side analog of the CLI watchdog)
Ingest runs a per-region watchdog that probes `https://<regional-tunnel>/health?nonce=…` with a one-time nonce and the same `samograph-health` marker the CLI already uses (`src/server.ts:HEALTH_MARKER`). Two consecutive failures flips the region to `degraded`, which (a) appends `SAMOGRAPH-WARNING: tunnel unreachable …` to every active call's live transcript stream in that region and (b) raises the dashboard banner. Recovery appends `SAMOGRAPH-WARNING: tunnel recovered` and clears the banner. The user is never silently shown an empty transcript — this is a v1 requirement, not a polish item.

## 5. Implementation details

### 5.1 Auth (magic link)
- `POST /auth/magic-link {email}` → server creates a one-time, single-use, 15-minute token, signs it (HMAC + KID), sends an email via a transactional provider (Postmark or Resend).
- `GET /auth/callback?token=…` → verifies (constant-time), creates/loads user, sets a signed session cookie (HttpOnly, Secure, SameSite=Lax).
- Rate limit: 5 magic-link requests / hour / email AND / IP.
- Deliverability: SPF + DKIM + DMARC on `samograph.dev` from day one (corporate mail will silently drop us otherwise — explicit risk in §10).
- No password reset, no account merge, no email change in v1.

### 5.2 Call lifecycle
```
user pastes URL
  → app-api validates (must be a known Zoom / Google Meet URL pattern)
  → app-api creates Call (status=PENDING) in DB
  → app-api enqueues bot-orchestrator job (call_id)
  → orchestrator picks region, calls Recall createBot with
       webhook_url = https://<region-tunnel>/webhook?bot=<bot_id>&t=<one-time>
     and per-call read/share tokens are pre-minted
  → status=JOINING
  → first transcript webhook arrives → status=IN_CALL, first_line_at recorded
  → Recall "call_ended" or owner "leave" → status=ENDED
```
Failure transitions are explicit: `COULD_NOT_JOIN`, `BOT_REMOVED`, `INGEST_DEGRADED` (a soft state — does not end the call, just raises the banner).

### 5.3 Transcript normalizer
Reuses `formatTranscriptLine` semantics from `src/transcript.ts` so the wire/disk format is byte-identical to the CLI. Inputs: Recall `transcript.data` payloads (varying word/partial shapes seen historically). Output: canonical `[YYYY-MM-DD HH:MM:SS] Speaker: utterance\n`. Pure function, no I/O, fed by the webhook handler. **TDD-built** (§6.2 entry 1).

### 5.4 WS fan-out + backpressure
- One in-process pub/sub channel per `call_id`.
- Each subscriber has a bounded outbound queue (default 256 messages / ~512 KB).
- Overflow policy: **drop oldest**, increment `ws_dropped_total{call_id}`, send a single `{type:"gap", since_seq, until_seq}` control frame so the client can request a backfill via REST.
- Slow client never blocks other subscribers in the same channel.
- Reconnect carries `?since_seq=…` for replay from Postgres.
- **TDD-built** (§6.2 entry 3).

### 5.5 Tenant-isolation authorization gate
A single function `authorizeCall(req) → { tenantId, callId, scopes }` is the only entry point. Every route, every WS upgrade, every bot-worker invocation calls it before touching state. Inputs accepted: session cookie, share token, [v2] agent token. Failure modes return 403 with no body. No code path may reach Recall without going through this gate. **TDD-built**, with adversarial cases (cross-tenant `call_id`, expired token, revoked token, token re-use across tenants) — §6.2 entry 4.

### 5.6 Capability tokens
- HMAC-SHA256 with a server secret, KID in the payload, JSON body `{kid, call_id, scopes[], iat, exp, jti}`.
- Always verified constant-time.
- Persisted in `tokens` table so revoke is O(1) on the server.
- `jti` is enforced as unique to prevent replay across rotations.
- v1 issues: `read` (per-call WS subscribe), `share` (read-only page, owner-revocable).
- v2 adds: `act:chat | act:frame | act:presence | act:leave`. Same generator, same verifier, just scoped strings.
- **TDD-built** (§6.2 entry 2).

### 5.7 Bot-worker command/act API (v1 seam for v2)
The bot-worker process per call exposes an internal HTTP surface (loopback only in v1):
- `POST /v1/call/:id/chat {message}`
- `POST /v1/call/:id/presence {state, message?}`
- `GET  /v1/call/:id/frames`
- `GET  /v1/call/:id/frame?source=…`
- `POST /v1/call/:id/leave`
In v1 only app-api can call it (owner actions from the dashboard). In v2 the agent gateway calls the exact same surface after token-service authorization. **No new bot-worker work in v2** other than wiring the agent gateway to it.

### 5.8 Data model (Postgres, RLS-enforced)
```
users          (id, email, created_at)
tenants        (id, owner_user_id, created_at)              -- 1:1 with user in v1
calls          (id, tenant_id, recall_bot_id, meeting_url,
                region, status, created_at, ended_at,
                first_line_at)
transcripts    (call_id, seq, ts, speaker, text)            -- append-only, PK (call_id, seq)
tokens         (id, call_id, scopes text[], kid, jti,
                expires_at, revoked_at)
audit_log      (id, tenant_id, call_id, actor, action,
                payload_sha256, ts)
regions        (id, tunnel_hostname, status, last_probe_ts)
```
RLS policy: every table that has `tenant_id` (directly or via `call_id`) is filtered by `tenant_id = current_setting('app.tenant_id')`. The tenancy gate is the only thing that sets that setting.

### 5.9 Observability (v1, minimum bar)
- Structured logs (JSON) with `call_id`, `tenant_id`, `region`.
- Counters: `bot_join_total{result}`, `transcript_lines_total{region}`, `ws_dropped_total{call_id}`, `tunnel_probe_failed_total{region}`.
- A single "activation funnel" dashboard: signup → magic-link clicked → call created → first transcript line → 30s of stream. This IS the v1 success metric (§9).

## 6. Tests plan

### 6.1 CI baseline
- `bun test` (existing harness) + `bunx tsc --noEmit` clean on every PR (same merge gate the repo already enforces, see CLAUDE.md). Adds new packages under `apps/web`, `apps/app-api`, `apps/ingest`, `apps/ws-hub`, `apps/bot-worker`, `packages/shared`.
- Postgres-backed integration tests run against an ephemeral container (no mocks — keep parity with prod migrations).
- One end-to-end smoke test in CI uses a Recall test endpoint or a mock-Recall fake to drive: magic-link → create call → ingest synthetic webhook → WS stream receives the line.

### 6.2 Red/green TDD list (write tests first; these are the subtle pieces)
1. **Transcript normalizer** (`packages/shared/transcript`). Inputs: a corpus of real Recall `transcript.data` shapes captured from the CLI's history; outputs: canonical lines. Red cases first — empty words array, partial vs final, missing speaker, Unicode, very long utterance, timestamp drift. Property test: same input → same output, idempotent across reorderings of words within a single utterance event.
2. **Capability token generator/verifier** (`packages/shared/tokens`). Red cases: wrong KID, expired, revoked, scope mismatch (request asks for `act:chat`, token holds only `read`), jti replay, tampered payload, timing-attack resistance (always constant-time compare). Green: round-trip for every scope combination.
3. **WS fan-out backpressure** (`apps/ws-hub`). Red cases: one slow subscriber must NOT slow others (assert publisher latency stays bounded); overflow must drop oldest and emit a single gap control frame; reconnect with `?since_seq` must produce exact missing range from Postgres; isolation across `call_id` channels.
4. **Tenant-isolation authorization gate** (`packages/shared/auth`). Adversarial cases: tenant A's share-token used to subscribe to tenant B's call → 403; expired token → 403; revoked token → 403 within 1 s of revoke; token bound to call X used on call Y → 403; no token, no session → 403; session present but `call_id` not in tenant → 403. Plus a fuzz round (random payloads must never return 2xx).
5. **Multi-call tunnel watchdog** (`apps/ingest`). Red cases: simulated 2 consecutive failed probes flips region to degraded; warning line is appended to every IN_CALL transcript in that region exactly once per outage; recovery appends a recovered line exactly once; flapping (fail-pass-fail) does not spam.

### 6.3 Manual test plan (mirrors §3 stories)
A scripted run-through per story, executed by the team on a staging tenant, recorded as the v0.1 acceptance gate.

## 7. Team (veteran experts to hire)

- **Veteran real-time meeting infrastructure engineer (1)** — Recall.ai integration, bot lifecycle, transcript ingest, regional cloudflared named tunnels, watchdog. *Lead engineer for the call path.*
- **Veteran backend / API engineer (1)** — app-api, Postgres schema + RLS, token service, capability model, audit log.
- **Veteran security engineer (1, fractional/0.5 in v1, full in v2)** — tenancy gate threat model, magic-link flow review, capability-token design, AI-agent channel design review for v2.
- **Veteran full-stack / Next.js engineer (1)** — marketing site, dashboard, per-call page, WS client, share-link page, degraded-banner UX.
- **Veteran SRE / platform engineer (1)** — Postgres + secret manager + one-region-then-multi-region deploy, cloudflared named-tunnel ops, on-call playbook, observability dashboards.
- **Veteran product designer (0.5)** — exactly the dashboard + per-call page + share modal; deliberately tiny scope to keep v1 small.

Total: 4.5 FTE in v1; +0.5 security in v2; product designer rolls off after v1.

## 8. Implementation plan (sprints, parallelization, ordering)

v1 target: **one week**, three sprints of ~2 days each. Sprints overlap heavily — work is parallelized by track, not gated end-to-end.

### Sprint 1 (Days 1–2) — "the seams"
Parallel tracks:
- **Backend (API engineer)** — Postgres schema + migrations (users, tenants, calls, transcripts, tokens, audit_log, regions) with RLS. App-api skeleton: `/auth/magic-link`, `/auth/callback`, `/calls` (create + read). **TDD** token generator/verifier (§6.2 #2). **TDD** tenancy gate (§6.2 #4).
- **Call-path (meeting infra engineer)** — `packages/shared/transcript` normalizer extracted from CLI, **TDD** (§6.2 #1). Bot-orchestrator skeleton; reuse `src/recall.ts` client; integrate with shared Recall key from secret manager. Stand up first regional cloudflared named tunnel.
- **SRE** — Provision Postgres (managed), secret manager (Recall key + email provider key + KID secret), one region's cloudflared named tunnel, CI matrix update.
- **Frontend (full-stack)** — Marketing landing at `samograph.dev`. Magic-link request + callback pages. Dashboard skeleton.
- **Security (fractional)** — Threat model for the tenancy gate; review token shape and KID rotation plan before code lands.

*Sprint exit:* a signed-in user can create a `Call` row from a URL; tokens round-trip; tenancy gate has full adversarial test coverage; one regional tunnel passes the `/health` round-trip.

### Sprint 2 (Days 3–5) — "the live transcript"
Parallel tracks:
- **Call-path** — Ingest service receives Recall webhooks, runs normalizer, writes to `transcripts`, publishes to fan-out hub. Multi-call tunnel watchdog (§6.2 #5), **TDD**. Bot-worker command/act API (loopback) wired to existing `chat/frame/frames/presence/leave` code paths from the CLI.
- **Backend** — WS hub (`/calls/:id/stream`) with bounded queues + backpressure + gap frames + `?since_seq` replay from Postgres, **TDD** (§6.2 #3). Share-link mint/revoke endpoints + `share` scope wiring. Audit-log writes for bot create/leave, share mint/revoke.
- **Frontend** — Per-call page: live WS, status states (JOINING / IN_CALL / ENDED / COULD_NOT_JOIN), degraded banner driven by warning lines, share modal.
- **SRE** — Activation-funnel dashboard wired to log counters; on-call playbook draft for `INGEST_DEGRADED` and `COULD_NOT_JOIN`.

*Sprint exit:* end-to-end happy path works against a real Recall bot on a real Zoom/Meet call; share link works; a forced tunnel outage in staging produces the warning line and clears it on recovery.

### Sprint 3 (Days 6–7) — "harden + ship"
Parallel tracks:
- **All** — Manual test pass of §3 stories on staging.
- **Call-path + SRE** — Add a second region behind the same regional-tunnel pattern (proves the multi-region seam without making it required for ship).
- **Backend + Security** — Rate-limit magic-link, rate-limit bot creation per tenant, rate-limit WS connections per call. Final review of tenancy gate, token verifier, RLS policies. Magic-link deliverability check against Gmail + at least one corporate mail (SPF/DKIM/DMARC live).
- **Frontend** — Past-calls list, transcript download, terminal failure UX, empty/loading states. Final marketing copy.

*Sprint exit:* the v1 acceptance test (§3 stories + W1 activation metric instrumented) passes on staging; deploy to prod behind a public URL.

### Phase 2 (next, not this week)
A single follow-on sprint adds: agent gateway (HTTP + WS + MCP), `act:*` scopes in the token verifier, per-token rate limits, agent-channel audit-log entries on every act call, dashboard "Connect AI agent" affordance with scope-picker + one-click revoke. Because the bot-worker command/act API and the capability-token model already exist, this should be days, not weeks.

## 9. Success metric

**v1 (single metric):** W1 activation = fraction of new signups who, within their first week, (a) paste a meeting link, (b) get the bot admitted into a real call, (c) and watch ≥30 s of live transcript stream on the per-call page. **Target ≥ 0.5.** Instrumented from the activation funnel dashboard (§5.9). This is the only number we optimize in v1.

**v2 (later, do not optimize in v1):** number of active calls with at least one AI-agent connection through the bidirectional channel.

## 10. Open questions / risks

1. **Shared Recall API key — tenant isolation.** Mitigation: the key never leaves bot-orchestrator + ingest; every request flows through the tenancy gate; audit log captures every Recall-mediated action; pen-test the gate before v2 launches the agent channel.
2. **AI-agent channel security (v2).** Capability-scoped, short-TTL, revocable tokens; rate-limited; full audit; never expose Recall key. Requires explicit security review before v2 ships.
3. **Act-channel abuse (v2).** An agent posting in someone's meeting / grabbing frames must be authorized, logged, and revocable. Per-token rate limits + per-tenant daily caps.
4. **Consent / recording disclosure across two-party-consent jurisdictions.** v1 surfaces a standing disclosure on the dashboard and in the per-call page. Legal sign-off needed before broad launch; not blocking the build-week.
5. **Recall.ai cost guardrails and free-tier limits.** Per-tenant active-call cap + per-tenant minutes/day cap in v1, conservative defaults, surfaced as a friendly error rather than a silent failure.
6. **Tunnel as single point of failure.** One regional named tunnel per region; watchdog with loud warnings; multi-region seam built in Sprint 3.
7. **Magic-link deliverability on corporate mail.** SPF/DKIM/DMARC from day one; warm IP via the transactional provider; explicit "didn't get it?" affordance with re-send + alternate-email entry. Tracked as a launch blocker.
8. **Regional named-tunnel ops.** cloudflared named tunnels require credentials + DNS — captured in the SRE on-call playbook.
9. **MCP endpoint shape for v2.** Spec'd in v2's design doc; v1 only needs the bot-worker command/act API to be MCP-compatible in payload shape (verbs are 1:1 with CLI).
10. **WS reconnect storms.** Bounded queues + `?since_seq` replay mean reconnect is cheap; per-IP connection cap on ws-hub as a safety belt.

## 11. Changelog (embedded; mirrors changelog.md)

- **v0.1 (2026-06-23)** — Initial draft. Two-phase scope (v1 zero-setup hosted samograph; v2 secure bidirectional AI-agent channel). Architecture with shared Recall key + regional named cloudflared tunnels + tenancy gate + capability tokens + audit log; v2 seams (bot-worker command/act API, capability-scoped tokens) wired in v1. TDD list for transcript normalizer, capability tokens, WS backpressure, tenancy gate, multi-call tunnel watchdog. 4.5-FTE team, three-sprint one-week plan. W1 activation ≥ 0.5 as the single v1 metric.
