# samograph.dev — SPEC v0.4

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
- Transcript persists to Postgres in real time and is **stored indefinitely** from day one (the durable record). Recall keeps video only ~7 days; **video storage is a v2 feature** (§5.13).
- Server-operated, multi-tenant equivalent of `samograph join`: one shared Recall API key (in secret manager), one persistent cloudflared **named** tunnel per region, webhook ingest routed by `bot_id`, WS fan-out hub.
- In-call recording disclosure (bot name + chat post on `in_call_recording`) so two-party-consent jurisdictions are addressed at the participant level, not just the dashboard (§10 #4).
- **Transcript-quality settings** (cheap Recall/Deepgram passthroughs, per-tenant defaults, no UI bloat to the core flow): **custom dictionary / keyterms** — a **PostgresFM** preset ships and users add their own terms — and **language** (a specific language or multilingual auto-detect, among Deepgram-supported languages). Transcription runs on **Deepgram** (via Recall). See §5.12.
- **Data deletion** (GDPR baseline, not deferred): the owner can delete a single call (its transcript + metadata, and the Recall recording via the Recall API) and can delete their account / all tenant data. See §5.14.
- **Multi-region seam proved in build-week:** a second region is deployed in Sprint 3 to validate the regional-tunnel pattern, but a single region is sufficient for ship; multi-region is not a launch gate (§4.7, §8).

### v2 — Phase 2 (next, deliberately deferred but architecturally pre-wired)
- Secure bidirectional AI-agent channel for an active call. The signed-in owner mints a per-call, capability-scoped, short-TTL, revocable token they paste into an external AI tool.
- **LISTEN scope:** subscribe to live transcript + bounded backfill.
- **ACT scope:** remote equivalents of `chat`, `frame`, `frames`, `presence`, `leave`. (1:1 with existing CLI verbs; the bot worker already supports them.)
- Exposed as HTTP + WebSocket API and an MCP server endpoint.
- Hard tenant isolation: an agent NEVER sees the Recall token, other calls, or other tenants. Full audit log of every act-channel call. Rate limits on the act channel. One-click revoke.
- **Billing & plans (Stripe):** per-seat subscriptions modeled on Circleback's pricing (Individual / Team / Enterprise; monthly + annual; trial). See §5.15.
- **Video storage:** egress Recall recordings to object storage (R2/B2) with **configurable N-month retention** (default 6 months); transcripts remain indefinite (since v1). See §5.13.
- **Expanded settings:** custom bot look (name + avatar; static vs dynamic presence), chat-chime **sound** selection, **calendar auto-join** (Google/Microsoft, with join rules), and retention controls. See §5.12.
- **Stronger tenant isolation:** move the per-call bot-worker tier to a **VM-grade boundary** (managed Firecracker microVMs) rather than shared-kernel containers. See §4.8.

### v3+ — explicitly deferred (do not design into v1/v2)
Branded/consistent bot identities; post-call transcript email; multi-language product UI; synced transcript+video viewer (click-a-word-to-seek); MS Teams + Webex; native integrations (Slack/Notion/CRM/Zapier); public REST API for tenants; EU data residency option; self-hosted Firecracker fleet on Hetzner bare-metal as a cost optimization over managed microVMs (§4.8).

## 3. User stories (manual-test backbone)

### v1 stories

**Story 1 — Zero-setup live transcript (primary v1 JTBD).**
- *Persona:* AI-forward engineer who already uses Claude Code / Codex and wants samograph in calls without local CLI + Recall token + tunnel.
- *Action:* opens `samograph.dev`, enters email, clicks the magic link, lands on dashboard, pastes a Zoom URL, clicks "Add to call".
- *Outcome:* the per-call page opens in ≤ 2 s of submit; status reaches `JOINING` within ≤ 5 s of submit; status reaches `IN_CALL` when Recall reports `in_call_recording` (typically 10–30 s, partly outside our control). **Pickup-latency SLO (what the team actually owns):** from the moment ingest receives the Recall `in_call_recording` event to the moment the per-call page renders the new status, **p95 ≤ 1 s** (asserted in §6.2 #8). Once `IN_CALL`, transcript lines start streaming live. Closing and re-opening the tab resumes without loss. After the call ends, the full transcript remains in the dashboard.

**Story 2 — Share the live transcript read-only.**
- *Persona:* same engineer (or a non-signed-in colleague / participant with hard-to-understand accent / multilingual viewer).
- *Action:* on the per-call page, owner clicks "Share" → gets a signed read-only URL → sends it to a teammate.
- *Outcome:* recipient opens the URL without signing in and sees the live transcript stream in real time, read-only (no controls to leave, mint AI tokens, or see other calls). The link is revocable from the owner's dashboard and stops working within ≤ 1 s of revoke. The share scope has explicit caps (§5.7): ≤ 200 concurrent WS connections per share token; ≤ 20 client→server commands/minute/connection; ≤ 1000 new connection establishments/hour/token (anti-fuzz). Exceeding any cap yields a friendly 429.

**Story 3 — Durable transcript after Recall's video TTL.**
- *Persona:* engineer reviewing a meeting 10 days later (past Recall's ~7-day video retention).
- *Action:* opens dashboard → "Past calls" → selects the call.
- *Outcome:* the full final transcript is shown with timestamps and speaker labels, downloadable as plain text (`[timestamp] Speaker: utterance` per line — identical to the CLI's local transcript format).

**Story 4 — Bot fails to join, clear failure mode.**
- *Persona:* engineer pasting a link to a meeting that has not started, or a malformed URL.
- *Action:* pastes URL, clicks "Add to call".
- *Outcome:* the per-call page transitions to a terminal failure state (`COULD_NOT_JOIN` with the underlying Recall reason surfaced in plain English). No silent hang — terminal states are driven by Recall bot lifecycle events (`call_ended`, `bot_removed`, `fatal`), not by the absence of transcript traffic. **"Try again" navigates back to the dashboard with the original URL pre-filled in the paste input; the user must explicitly re-submit to create a new Call row (no implicit retry).** This keeps the audit log clean (one user action = one Call row) and gives the user a chance to edit the URL.

**Story 5 — Mid-call tunnel/ingest outage is loud, never silent.**
- *Persona:* engineer watching a live transcript when the regional tunnel or webhook ingest degrades.
- *Action:* keeps the per-call page open.
- *Outcome:* within ≤ 2 probe intervals (default probe interval 20 s → banner visible within ≤ 40 s) a banner appears ("Transcript delivery degraded — recovering…") and a `SAMOGRAPH-WARNING: tunnel unreachable …` line is appended to the live transcript stream, mirroring the CLI's behavior. When ingest recovers a `SAMOGRAPH-WARNING: tunnel recovered` line is appended and the banner clears. The user is never silently shown an empty transcript while the bot is in the call. The banner is driven by `calls.ingest_degraded = true` (an overlay flag, not a status enum value — see §5.10), so a call can be `IN_CALL` and `ingest_degraded` simultaneously.

**Story 6 — In-call recording disclosure (consent).**
- *Persona:* any participant in a call the samograph bot joins (not necessarily a samograph user).
- *Action:* the bot joins the call and Recall reports `in_call_recording`.
- *Outcome:* the bot's displayed participant name is `samograph (recording)` (recognizable bot identity) and the bot posts a single chat message on entering `in_call_recording` ("samograph is recording this call's audio for the host's live transcript — samograph.dev"). Owner can see, but not suppress, the disclosure in v1. If Recall ever reports `in_call_not_recording` instead, the bot does NOT post a recording disclosure (it would be factually wrong); the call transitions to terminal `COULD_NOT_RECORD` and the bot leaves cleanly (§5.2, §5.9).

### v2 stories (specified now to keep v1 architecture honest; **not built in v1**)

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
  │     Recall API key     │   │     tokens (share now;   │
  │   - creates Recall bot │   │     act:* in v2)         │
  │   - registers call_id  │   │   - HMAC-signed, KID     │
  │     with ingest        │   │     rotated, revocable   │
  │   - registers bot-     │   │   - read scope is        │
  │     worker address in  │   │     session-derived,     │
  │     workers table      │   │     NOT persisted        │
  │                        │   │   - ingest_secret per    │
  │                        │   │     call (separate from  │
  │                        │   │     user-visible tokens) │
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
- **`Call`** — `(id, tenant_id, recall_bot_id, meeting_url, region, status, ingest_degraded, created_at, ended_at, ingest_secret_hash)`. `status` is a single enum (§5.2); `ingest_degraded` is a separate boolean overlay that does not change `status` (§5.10).
- **`CapabilityToken`** — `(id, call_id, scopes[], ttl, revoked_at, kid)`. **Only scopes that need server-side persistence are stored as `CapabilityToken` rows.** In v1 that means exactly the `share` scope (defined in §5.7). v2 adds `act:chat | act:frame | act:presence | act:leave`, also persisted. The `read` scope is NOT a CapabilityToken — it is derived from the owner's authenticated session by the tenancy gate (§5.7). The same verifier handles all persisted scopes.
- **`IngestSecret`** — a per-call, server-side-only secret encoded in the Recall webhook URL as `?t=…`. Not a `CapabilityToken`; never user-visible; never returned by any API. Stored as a SHA-256 hash in `calls.ingest_secret_hash` and verified in constant time on every webhook POST. Survives the full call lifetime (so it CANNOT be "one-time" — Recall posts many webhooks per call) and is invalidated when the call enters a terminal state.
- **`TranscriptLine`** — append-only `(call_id, seq, ts, speaker, text)`. The normalizer turns Recall transcript events into this canonical shape.
- **`AuditEvent`** — written on every privileged action (mint token, revoke, bot create/leave, share mint/revoke; v2: every act-channel call).
- **`Tenancy gate`** — single helper used by every authenticated route + WS upgrade: `(session | token) → tenant_id → call_id ∈ tenant_id`. Detailed in §5.6.
- **`Worker registration`** — on start, bot-worker writes `(call_id, host, port, worker_secret_hash)` to `workers`; app-api/agent-gateway look up by `call_id` and authenticate the inter-service call with the per-worker secret (and mTLS in prod). Provides service discovery so the "same code path" claim (§5.8) is real, not aspirational.

### 4.3 Why one named regional tunnel, not one tunnel per call
The CLI's per-call ngrok model does not scale and is the single largest contributor to mid-call failure (the existing `ERR_NGROK_727` story). One persistent cloudflared **named** tunnel per region gives a stable DNS hostname, no per-call provisioning latency, and one shared health surface. Per-call routing is encoded in the webhook URL (`?bot=<id>&t=<ingest_secret>`) and verified at the tenancy gate. The mid-call watchdog (§4.5) runs once per region, not once per ingest replica (see leader election, §4.6).

### 4.4 Why a shared Recall API key (and the boundary that makes it safe)
A single Recall key in a secret manager is the only practical v1 model (Recall does not give per-tenant child keys at our scale). Tenant isolation is therefore enforced **above** Recall: (a) the key only exists in the bot-orchestrator and ingest processes; (b) every request that names a `bot_id` passes through the tenancy gate before any Recall call; (c) the AI-agent channel in v2 is mediated by token-service + bot-worker — the agent never holds or sees the Recall key; (d) the audit log captures every Recall-mediated action; (e) the webhook authenticity check (Recall signature + `ingest_secret`) prevents external spoofing of `?bot=<victim>` (§5.3, §6.2 #7).

### 4.5 Tunnel watchdog (server-side analog of the CLI watchdog)
Ingest runs a per-region watchdog that probes `https://<regional-tunnel>/health?nonce=…` with a one-time nonce and the same `samograph-health` marker the CLI already uses (`src/server.ts:HEALTH_MARKER`). **Default probe interval = 20 s.** Two consecutive failures flip the region to `degraded`, which (a) appends `SAMOGRAPH-WARNING: tunnel unreachable …` to every active call's live transcript stream in that region, (b) sets `calls.ingest_degraded = true` for every IN_CALL call in the region, and (c) raises the dashboard banner. Recovery appends `SAMOGRAPH-WARNING: tunnel recovered`, clears `ingest_degraded`, and clears the banner.

### 4.6 Watchdog leader election (replica-safe "exactly once")
Ingest scales horizontally. To preserve "exactly one warning line per outage" across replicas, the watchdog runs only on the **leader** for a region. Leader election uses a Postgres advisory lock keyed on `region_id` with a 60 s lease (renewed every 20 s; expires automatically if the leader dies). Only the leader writes to `regions.status` and `calls.ingest_degraded`, only the leader emits warning/recovery lines. Followers run no probes. Tested explicitly under concurrent replicas (§6.2 #5).

### 4.7 Region selection policy
v1 ships to production behind a single region (`us-east`); a second region is deployed in Sprint 3 to prove the multi-region seam (§8) — both decisions live inside the v1 build week. **Multi-region is not a launch gate**: a single healthy region is sufficient for the v1 ship. When ≥ 2 regions are live, `calls.region` is set at orchestrator time by: (a) user-pinned override if present, else (b) lowest-latency healthy region for the orchestrator host (round-robin within ties). A region marked `degraded` fails **closed** for new calls (orchestrator skips it) and the chosen alternative is logged. Already-IN_CALL calls in a degraded region are not migrated (Recall does not support cross-region bot migration); they continue to surface the warning until recovery.

### 4.8 Tenant compute isolation roadmap (data isolation now, VM-grade isolation later)
Isolation has two layers and we are explicit about which one each phase buys:

- **Data isolation (v1, shipped):** a single multi-tenant Postgres with **Row-Level Security** (§5.10). This is a strong boundary for *data* but says nothing about *compute*.
- **Compute isolation (v1, weaker):** the per-call `bot-worker` processes run as **hardened containers** (seccomp + user namespaces + AppArmor/SELinux, read-only rootfs, no host mounts). A container shares the host kernel — it is **NOT a security boundary equal to a VM** and we do not pretend otherwise. It is adequate for v1 because the workers run *our* code, not tenant-supplied code.

The concern (correctly raised) is that as we grow — and especially once the v2 AI-agent channel lets external agents drive a worker — we want **VM-grade isolation per tenant/per call**. Findings that shape the path (researched 2026-06, re-verify before committing):

- **Hetzner Cloud (CX/CPX/CCX) has no nested virtualization** — `/dev/kvm` is unavailable inside the guest, so **Firecracker / Cloud Hypervisor / Kata cannot run on Hetzner Cloud VMs**. Only **Hetzner dedicated / bare-metal** exposes KVM.
- **Firecracker** boots ≤125 ms with ~5 MiB overhead and runs long-lived processes fine, but **networking is DIY** (TAP + host NAT/DNAT + per-VM IPAM) and **snapshots do not preserve connections** — the bot must already treat reconnect-to-Recall as first-class (it does).
- **gVisor** needs no KVM (runs on Hetzner Cloud), is **stronger than a container but weaker than a VM**, at ~10–30% I/O overhead — a pragmatic middle tier.
- **Managed Firecracker (Fly.io Machines)** gives the same microVM boundary with networking solved, EU regions (fra/ams), scale-to-zero, ~**$2/mo** for an always-on 256 MB machine. AWS Fargate is the same boundary at ~$9/mo min; Lambda is disqualified (15-min cap kills long WebSockets).

**Recommended path:** v1 = RLS + hardened containers. **v2 moves the bot-worker tier to a VM-grade boundary**, starting with **managed Firecracker (Fly.io Machines)** — rent the isolation rather than build a Firecracker fleet (DIY networking/snapshot/jailer lifecycle is months of infra). Keep the stateless services (app-api, ingest, ws-hub) on Hetzner Cloud; gVisor is the fallback if we must keep the worker tier on Hetzner Cloud. **v3** revisits **self-hosted Firecracker on Hetzner bare-metal** purely as a cost optimization once volume justifies the ops. The key trade-off: Hetzner-bare-metal Firecracker is far cheaper per unit but loads the team with the hardest ops; managed microVMs cost a few dollars per always-on bot and hand us the boundary with networking solved.

### 4.9 Cloudflare reliability & dependency posture
We use a self-hosted **cloudflared named tunnel** for webhook ingest (§4.3). Posture decisions (researched 2026-06):

- **Tunnel is the right ingest choice.** It is **free on any plan**, has **no ngrok-style monthly request cap** (the CLI's `ERR_NGROK_727` was ngrok-free's 20k-requests/month quota), and **named** tunnels on an owned domain are the production path (quick `trycloudflare.com` tunnels are dev-only: 200-concurrent cap, no SLA). Caveat: **no contractual uptime SLA below the Business plan** (~$200–250/mo).
- **Cloudflare compute is the wrong shape for the bot-workers.** They hold a long-lived **outbound** WebSocket to Recall for the whole meeting plus arbitrary outbound networking — exactly where Durable Objects bill GB-s for the entire call (outbound WS does not hibernate) and Containers restrict outbound to ports 80/443 with ephemeral disk and no run-duration/SLA guarantee. **Bot-workers stay on Hetzner/Fly, not Cloudflare.**
- **Do not make Cloudflare a hard single dependency for live delivery.** Cloudflare had two notable data-plane outages in the research window (Jun 2025 Workers KV ~2h28m; Nov 2025 ~6h global 5xx). Mitigations: a per-region named tunnel (already), the ability to fail over to a second tunnel/`--webhook-base` (the CLI already supports `--tunnel cloudflared`/`--webhook-base`), and treating any Worker+Queues+R2 durable-buffer pattern as **optional hardening**, never on the critical live path.

### 4.10 Secrets & scheduled key rotation
All long-lived secrets live in a secret manager; the **shared Recall API key exists only in bot-orchestrator + ingest** (§4.4). Rotation is scheduled, not ad-hoc:

- **Recall API key — scheduled rotation (e.g., every 90 days) + on-demand (incident).** Mechanics: provision a new Recall key, run a **dual-key overlap window** — new bots are created with the new key while bots already created under the old key keep using it — then **drain** (wait until no active call references the old key, bounded by max call length + a margin), then revoke the old key. Fully automated via a scheduled job with a runbook; a forced (incident) rotation skips the schedule and shortens the drain to "leave + rejoin active bots."
- **App secrets** rotate on the cadences already pinned elsewhere: magic-link/token **KID every 90 days with a 30-day overlap** (§5.1, §5.7), per-region **webhook secrets** and per-worker **secrets** rotated on the same 90-day schedule. All rotations are logged to `audit_log`.

### 5.1 Auth (magic link)
- `POST /auth/magic-link {email}` → server creates a one-time, single-use, 15-minute token, signs it (HMAC + KID), sends an email via a transactional provider (Postmark or Resend).
- `GET /auth/callback?token=…` → verifies in **constant time**, marks the token consumed (idempotent, replay-safe), creates/loads user, sets a signed session cookie (HttpOnly, Secure, SameSite=Lax). A second use of a consumed token returns 401 with no body.
- Concurrent outstanding links per email: the most recently issued link supersedes prior ones (older outstanding tokens are invalidated server-side at issue time).
- Rate limits, expressed as separate counters (whichever fires first blocks):
  - **per-email**: 5 requests / hour.
  - **per-IP**: 20 requests / hour.
- Deliverability: SPF + DKIM + DMARC on `samograph.dev` from day one (corporate mail will silently drop us otherwise — §10).
- KID rotation: rotated every 90 days; both current and previous KIDs are accepted during a 30-day overlap window.

### 5.2 Call lifecycle
Driven by Recall bot lifecycle events, NOT by transcript traffic. A silent call (no one speaking) must still transition to `IN_CALL`.

```
user pastes URL
  → app-api validates (must be a known Zoom / Google Meet URL pattern)
  → app-api creates Call (status=PENDING, ingest_degraded=false) in DB
  → app-api enqueues bot-orchestrator job (call_id)
  → orchestrator picks region per §4.7, generates ingest_secret,
    stores ingest_secret_hash on Call, calls Recall createBot with
       webhook_url = https://<region-tunnel>/webhook?bot=<bot_id>&t=<ingest_secret>
    and pre-mints per-call share token slot (token row created on user click,
    not implicitly)
  → status=JOINING (set on Recall ack of createBot — SLO ≤ 5 s of submit)
  → status=IN_CALL on Recall bot lifecycle event `in_call_recording`
    (NOT first transcript line — guarantees silent calls progress.
    Pickup-latency SLO: event received → status visible on per-call page
    ≤ 1 s p95, asserted in §6.2 #8.)
  → status=COULD_NOT_RECORD (terminal) on Recall lifecycle event
    `in_call_not_recording`. Recording is required for the product to
    function; bot leaves the call cleanly and no "recording" disclosure
    chat post is sent (§5.9).
  → status=ENDED on Recall `call_ended` OR owner "leave" verb
  → status=COULD_NOT_JOIN on Recall `fatal` / non-recoverable failure;
    on owner "Try again" the user is returned to the dashboard with
    URL pre-filled (Story 4); a new Call row is created only on their
    explicit re-submit.
  → status=BOT_REMOVED on Recall `bot_removed`

  `ingest_degraded` is an INDEPENDENT boolean overlay column on Call
  (§5.10). It can flip true/false at any time while status is IN_CALL
  without changing status, and it is reset to false on any terminal
  status transition. The per-call page shows "IN_CALL + degraded" by
  reading both columns; the lifecycle diagram above intentionally does
  NOT list `INGEST_DEGRADED` as a status enum value.
```
First-line latency is still recorded (`first_line_at`) for the activation funnel (§9) but is not the trigger for `IN_CALL`.

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
- Slow client never blocks other subscribers in the same channel — explicitly including the realistic case of **k > 1 concurrently stalled subscribers** in the same channel (e.g., a share link to a large internal audience on spotty Wi-Fi). The publisher-side per-message latency SLO holds for **k ≤ 32 stalled subscribers at queue-full**: **p99 ≤ 5 ms / message** (asserted in §6.2 #3, with the measurement methodology spelled out there).
- Reconnect carries `?since_seq=…` for replay from Postgres.
- No in-process token cache on the hot path; one DB lookup per WS upgrade (revoke-within-1s SLO depends on this — §6.2 #4). If a cache is ever added, a cache-invalidation test must land in the same PR.
- **TDD-built** (§6.2 #3).

### 5.6 Tenant-isolation authorization gate
A single function `authorizeCall(req) → { tenantId, callId, scopes }` is the only entry point. Every route, every WS upgrade, every bot-worker invocation calls it before touching state. Inputs accepted: session cookie (derives `read` scope for any `call_id` whose `tenant_id` matches the session's tenant), share token (derives `share` scope, persisted in `tokens`), [v2] agent token (derives `act:*` scopes, persisted in `tokens`). Failure modes return 403 with no body. No code path may reach Recall without going through this gate. **TDD-built**, with adversarial cases (cross-tenant `call_id`, expired token, revoked token, token re-use across tenants) — §6.2 #4.

### 5.7 Capability tokens & v1 scope model
**Persisted vs derived scopes.** v1 has exactly two scopes, but they are produced differently and the spec is concrete about that:

- **`read` (derived, not persisted).** Issued implicitly by the tenancy gate (§5.6) when a request carries a valid owner session cookie AND the requested `call_id`'s `tenant_id` matches the session's tenant. There is NO `tokens` row for the `read` scope. "Revocation" of a `read` capability is achieved by signing out / session expiry; it is not independently revocable, and that is by design. Per-connection WS rate limit: 60 client→server commands/minute; max 10 concurrent WS connections per user session per call. Audit entries attribute the actor as `user:<id>`.
- **`share` (persisted CapabilityToken).** Issued explicitly by the owner via "Share" — this writes a row to `tokens` with `scopes=['share']`, a `kid`, a `jti`, and `expires_at`. Owner-revocable at any time by setting `revoked_at` (one-click; ≤ 1 s revoke SLO, §3 Story 2). Per-connection WS rate limit: 20 client→server commands/minute. Per-token concurrent-connection cap: 200. Per-token connection-establishment rate: 1000 / hour (anti-fuzz). Audit entries attribute the actor as `share:<token-id>`. The read-only HTML page hides all owner-only controls.

**v2 additions** (NOT built in v1, but the verifier supports them already): `act:chat | act:frame | act:presence | act:leave`, each persisted in `tokens` with explicit numeric per-token rate limits to be set in the v2 design doc.

**Persisted-token shape** (applies to `share` and v2 `act:*`): HMAC-SHA256 with a server secret, KID in the payload, JSON body `{kid, call_id, scopes[], iat, exp, jti}`. Always verified constant-time. `jti` is enforced unique to prevent replay across rotations. KID rotation cadence: 90 days, with 30 days of overlap (same policy as §5.1). **No verifier-side caching in v1** (§5.5).

**TDD-built** (§6.2 #2).

### 5.8 Bot-worker command/act API (v1 seam for v2)
The bot-worker process per call exposes an HTTP surface bound to a registered `host:port`:
- `POST /v1/call/:id/chat {message}`
- `POST /v1/call/:id/presence {state, message?}`
- `GET  /v1/call/:id/frames`
- `GET  /v1/call/:id/frame?source=…`
- `POST /v1/call/:id/leave`
**Service discovery + auth.** On start, bot-worker generates a per-instance secret, writes `(call_id, host, port, worker_secret_hash, last_heartbeat_at)` to the `workers` table, and binds to a private network interface. app-api (v1) and agent-gateway (v2) resolve the worker by querying `workers` for `call_id`, then call it with the per-instance secret in an `Authorization: Bearer` header. In production the call is also mTLS (VPC-internal CA). In dev the worker binds to loopback and the secret alone authenticates. **No new bot-worker work in v2** other than wiring the agent gateway to it.

### 5.9 In-call recording disclosure (consent)
- Bot's Recall display name is `samograph (recording)` in v1. Cannot be customized.
- The disclosure chat line is posted **exactly once, only on the `in_call_recording` lifecycle event**: `"samograph is recording this call's audio for the host's live transcript — samograph.dev"`.
- If Recall instead reports `in_call_not_recording`, the bot **does NOT post any recording disclosure** (claiming "is recording" would be factually wrong and harmful). The call transitions to terminal `COULD_NOT_RECORD` (§5.2) and the bot leaves the call cleanly. The dashboard surfaces a friendly "Could not start recording — please check meeting recording permissions" message.
- The disclosure post is non-suppressible in v1 (owner cannot disable it). Future per-jurisdiction tuning is deferred.
- This is the in-call leg of the two-party-consent mitigation; the dashboard-side disclosure (§10 #4) remains for the host.

### 5.10 Data model (Postgres, RLS-enforced)
```
users          (id, email, created_at)
tenants        (id, owner_user_id, created_at)              -- 1:1 with user in v1
calls          (id, tenant_id, recall_bot_id, meeting_url,
                region, status, ingest_degraded boolean,
                created_at, ended_at, first_line_at,
                ingest_secret_hash)
transcripts    (call_id, seq, ts, speaker, text)            -- append-only, PK (call_id, seq)
tokens         (id, call_id, scopes text[], kid, jti,
                expires_at, revoked_at)                     -- ONLY persisted scopes:
                                                            --   share (v1), act:* (v2).
                                                            --   read is NOT stored here.
audit_log      (id, tenant_id, call_id, actor, action,
                payload_sha256, ts)
workers        (call_id PK, host, port, worker_secret_hash,
                registered_at, last_heartbeat_at)
regions        (id, tunnel_hostname, status, last_probe_ts,
                leader_id, leader_lease_expires_at)
```
RLS policy: every table that has `tenant_id` (directly or via `call_id`) is filtered by `tenant_id = (SELECT current_setting('app.tenant_id'))::uuid`. **The `current_setting(...)` MUST be wrapped in a scalar sub-`SELECT`.** Without the wrapper, Postgres treats `current_setting(...)` as a volatile function call and re-evaluates it **per row** (and can defeat index usage), which is catastrophic on large transcript scans; wrapped in `(SELECT …)` the planner caches it as a **once-per-statement InitPlan**. This is the well-documented Postgres/Supabase RLS performance pattern and is mandatory on every policy here. The tenancy gate is the only thing that sets `app.tenant_id` (via `set_config('app.tenant_id', $1, true)` — transaction-local). `workers` is RLS-filtered by joining `calls.tenant_id` (the same `(SELECT …)` wrapper applies inside the join predicate). `calls.status` is a single enum (`PENDING | JOINING | IN_CALL | ENDED | COULD_NOT_JOIN | COULD_NOT_RECORD | BOT_REMOVED`); `calls.ingest_degraded` is an INDEPENDENT boolean overlay (§5.2), reset to false on any terminal status transition.

### 5.11 Observability (v1, minimum bar)
- Structured logs (JSON) with `call_id`, `tenant_id`, `region`.
- Counters: `bot_join_total{result}`, `transcript_lines_total{region}`, `ws_dropped_total{call_id}`, `tunnel_probe_failed_total{region}`, `webhook_rejected_total{reason}`, `pickup_latency_ms{p50,p95,p99}` (event-received → status-visible).
- A single "activation funnel" dashboard: signup → magic-link clicked → call created → first transcript line → 30s of stream. This IS the v1 success metric (§9).

### 5.12 Settings
Per-tenant settings with a per-call override where noted. Transcription runs on **Deepgram** (selected as Recall's transcription provider), so dictionary and language map directly onto Deepgram features. Each row is tagged with the phase it ships in; v1 keeps to cheap passthroughs so the core flow stays "deliberately tiny."

| Group | Setting | Phase | Mechanism / notes |
|---|---|---|---|
| **Look** | Bot display name | v1 fixed → v2 custom | v1 = fixed `samograph (recording)`. v2 = custom name via Recall, but it MUST still signal recording (consent, §5.9). |
| **Look** | Presence: dynamic vs static | v1 dynamic (default) → v2 toggle | v1 ships the dynamic presence camera (`listening/thinking/speaking/acting/idle`) from the CLI. v2 adds a static-image toggle. Dynamic presence is a **differentiator** (Circleback has no equivalent). |
| **Look** | Avatar / picture | v2 | Custom bot image via Recall. |
| **Sound** | Chat-chime sound | v1 (selectable) | Choose among the shipped **sound library** (~10 chimes, CLI PR #31). Per-tenant default + per-call override; played when the bot posts chat (disclosure in v1, agent chat in v2). |
| **Transcription** | Dictionary / keyterms | v1 | Predefined presets (**PostgresFM** ships) **plus** user-defined terms; passed through as **Deepgram keyterm prompting** via Recall. Per-tenant + per-call override. |
| **Transcription** | Language | v1 | A specific language **or** multilingual auto-detect, among **Deepgram-supported** languages (Nova multilingual). Per-tenant default + per-call override. Code-switching / mixed-language transcript is a tracked **differentiator** (Circleback is single-dominant-language). |
| **Calendar** | Auto-join calendar events | v2 | Connect Google / Microsoft calendar; auto-join rules: only meetings I organize / internal-domain / external / decline-not-accepted / per-event opt-out. Re-introduces calendar (deliberately excluded from v1). |
| **Privacy** | Recording-disclosure toggle | v1 fixed → v2 configurable | v1 = non-suppressible (§5.9). v2 = per-jurisdiction tuning. |
| **Privacy** | Video retention (N months) | v2 | Configurable; transcript retention is fixed = indefinite (§5.13). Team-plan-gated. |
| **Data** | Export / delete | v1 | Export `.txt`/`.md` (v1); delete a call or the whole account (§5.14). PDF export = v2. |

Deferred to v3 (noted so settings UI leaves room): bot-free capture, native integrations (Slack/Notion/CRM/Zapier), public REST API, EU data residency. "Worth checking Circleback" review folded in — the items above plus those v3 deferrals are the union of Circleback's settings and our differentiators.

### 5.13 Data retention
- **Transcripts: indefinite from v1.** They are the durable product record and persist until the tenant deletes them (§5.14). ~50 KB per meeting-hour of plain text — cheap; a `text`/compressed column in Postgres is fine well past 100 GB.
- **Video: not stored in v1.** v1 relies on Recall's ~7-day window and persists nothing. **v2 egresses** the recording (mixed MP4 and/or `video_separate_png` frames) to S3-compatible object storage — **Cloudflare R2** (~$0.015/GB-mo, zero egress) or **Backblaze B2** — with **configurable per-tenant retention (default 6 months)** and a daily auto-purge job. A 1-hour 720p meeting is ~0.5–1 GB, so video dominates storage cost and is the reason retention is bounded and configurable (and Team-plan-gated).
- Deletion of a call or account purges both transcript and any stored video and asks Recall to delete its copy (§5.14).

### 5.14 Data deletion (GDPR baseline — v1)
- **Delete a single call:** removes its `transcripts` rows and any stored video, revokes its `tokens`, and calls the **Recall API to delete the Recall recording**. A tombstone (`call_id, deleted_at, deleted_by`) is retained for audit integrity; the deletion itself is an `audit_log` entry. Deletes run under the same RLS tenant scope (§5.10) — you can only delete your own.
- **Delete account / all tenant data:** purges all of the tenant's `calls`, `transcripts`, `tokens`, `workers`, audit detail, and stored video; revokes all sessions; deletes the Recall recordings; emails a confirmation. Honors a **GDPR erasure SLA (≤ 30 days)**, with active calls force-left first.
- **Export-before-delete** is offered in the flow. v2 adds retention-policy auto-purge and granular export formats.

### 5.15 Billing & plans (v2 — Stripe)
v1 is **free** behind the rate/cost guardrails (§10 #5). v2 introduces paid plans via **Stripe**, on a **per-seat recurring-subscription** model **matching Circleback's structure** (per-seat, unlimited meetings under fair-use; monthly + annual with ~2 months off annual; trial; no permanent free tier). Proposed tiers (numbers to confirm against current Recall unit cost):

| Plan | Price (annual / monthly per seat) | Includes |
|---|---|---|
| **Individual** | ~$20 / ~$25 | Live transcript, share links, dictionary + languages, exports, the v2 AI-agent channel |
| **Team** | ~$25 / ~$30 | + shared meeting library, retention controls + video storage, access controls, usage dashboard, centralized billing |
| **Enterprise** | custom | + SSO, advanced security controls, BAA, EU residency |

**Stripe mechanics:** two catalog Products (Individual, Team), each with two recurring Prices (monthly + yearly), `usage_type = licensed` billed by `quantity = seats`, `trial_period_days` (e.g., 14). Stripe **Customer Portal** for self-serve plan/seat/card changes. Webhooks (`checkout.session.completed`, `customer.subscription.updated|deleted`, `invoice.payment_failed`) drive a `tenants.subscription_status` (`trialing | active | past_due | canceled`) that gates access. Enterprise is a manual/custom quote outside the self-serve catalog.

**Margin guardrail (important):** Recall bills **per-minute** but per-seat pricing is **flat**, so heavy users can be unprofitable. Enforce **fair-use minute caps per seat/month** (friendly soft limit, not a hard cutoff mid-call), monitor **margin per tenant**, and keep the v1 cost guardrails (§10 #5) as the floor. This is the central billing risk (§10 #13).

### 5.16 Error handling & error-code reference
**Principle:** every failure is typed, surfaced to the user in plain English, and never a silent hang. API errors return `{ "code": "SAMO-…", "message": "<human>", "retryable": bool }` with the HTTP status below; call-path failures map to a terminal `calls.status` (§5.2). Codes are stable (safe to switch on) and logged with `call_id`/`tenant_id`.

| Code | HTTP / call status | Meaning | User-facing message | Client behavior |
|---|---|---|---|---|
| `SAMO-AUTH-001` | 401 | Magic link invalid / tampered KID / bad signature | "This sign-in link isn't valid." | Request a new link |
| `SAMO-AUTH-002` | 401 | Magic link expired (>15 min) | "This sign-in link has expired." | Request a new link |
| `SAMO-AUTH-003` | 401 | Magic link already used (replay) | "This link was already used." | Request a new link |
| `SAMO-AUTH-004` | 429 | Magic-link rate limit (5/hr email or 20/hr IP) | "Too many sign-in attempts — try again shortly." | Back off, honor `Retry-After` |
| `SAMO-AUTHZ-001` | 403 | Tenancy gate: cross-tenant `call_id` / no session | "You don't have access to this call." | Stop; do not retry |
| `SAMO-TOKEN-001` | 403 | Token scope mismatch (e.g. `read` asked for `act:*`) | "This link can't perform that action." | Stop |
| `SAMO-TOKEN-002` | 410 | Token revoked or expired | "This share/agent link is no longer active." | Stop; owner must re-issue |
| `SAMO-RATE-001` | 429 | Share/agent connection or command cap hit (§5.7) | "Too many connections/commands on this link." | Back off, honor `Retry-After` |
| `SAMO-CALL-JOIN` | status `COULD_NOT_JOIN` | Recall `fatal` before join (bad URL, denied entry) | "Couldn't join — <Recall reason>." | "Try again" → dashboard, URL pre-filled (Story 4) |
| `SAMO-CALL-NOREC` | status `COULD_NOT_RECORD` | Recall `in_call_not_recording` | "Couldn't start recording — check meeting permissions." | No disclosure post; bot leaves (§5.9) |
| `SAMO-CALL-REMOVED` | status `BOT_REMOVED` | Host removed the bot | "The bot was removed from the call." | Terminal |
| `SAMO-INGEST-DEGRADED` | overlay (not a status) | Tunnel/ingest outage mid-call | banner + `SAMOGRAPH-WARNING: tunnel unreachable …` line | Auto-recovers; lines during outage are lost |
| `SAMO-WEBHOOK-401` | 401 (server↔Recall) | Bad Recall signature or `ingest_secret` mismatch | (internal; never user-facing) | Dropped, logged once |
| `SAMO-WORKER-503` | 503 | Bot-worker unreachable (crash/stale row) | "That action is temporarily unavailable." | Retry once; transcript keeps flowing |
| `SAMO-RECALL-COST` | 429 | Per-tenant active-call / minutes guardrail hit (§10 #5) | "You've reached your usage limit for now." | Surface limit; no silent failure |
| `SAMO-BILLING-PASTDUE` | 402 (v2) | `invoice.payment_failed` → `past_due` | "Payment failed — update your card to keep using samograph." | Stripe Customer Portal link |
| `SAMO-BILLING-SEATS` | 403 (v2) | Seat limit exceeded | "You've used all your seats." | Add seats in billing |

## 6. Tests plan

### 6.1 CI baseline
- `bun test` (existing harness) + `bunx tsc --noEmit` clean on every PR (same merge gate the repo already enforces, see CLAUDE.md). Adds new packages under `apps/web`, `apps/app-api`, `apps/ingest`, `apps/ws-hub`, `apps/bot-worker`, `packages/shared`.
- Postgres-backed integration tests run against an ephemeral container (no mocks — keep parity with prod migrations).
- CI smoke test: **uses a deterministic in-repo Recall fake** (`packages/test-fakes/recall`) on every PR. A separate **nightly** job runs the same scenario against the real Recall sandbox endpoint.

### 6.2 Red/green TDD list (write tests first; these are the subtle pieces)
1. **Transcript normalizer** (`packages/shared/transcript`). Inputs: a corpus of real Recall `transcript.data` shapes captured from the CLI's history; outputs: canonical lines. Red cases first — empty words array, partial vs final, missing speaker, Unicode, very long utterance, timestamp drift. Property test: same input → same output, idempotent across reorderings of words within a single utterance event.
2. **Capability token generator/verifier** (`packages/shared/tokens`). Red cases: wrong KID, expired, revoked, scope mismatch (request asks for `act:chat`, token holds only `share`), jti replay, tampered payload, timing-attack resistance (always constant-time compare). Green: round-trip for every PERSISTED scope (`share` in v1; `act:*` in v2). Separate test surface for the `read` scope: confirm the tenancy gate (§5.6) issues `read` purely from a valid session + matching tenant on `call_id`, with **no `tokens` row created** (verified by row-count assertion on `tokens`), and confirm that signing out invalidates the implied `read` capability within 1 s.
3. **WS fan-out backpressure** (`apps/ws-hub`). Red cases: with **k stalled subscribers** at queue-full for k ∈ {1, 4, 16, 32} in the same `call_id` channel, **publisher-side per-message latency p99 ≤ 5 ms** must hold; overflow must drop oldest and emit a single gap control frame; reconnect with `?since_seq` must produce exact missing range from Postgres; isolation across `call_id` channels; queue cap hits at min(256 msgs, 512 KB). **Measurement methodology (explicit, not handwaved):** dedicated CI runner with single-tenant isolation (one benchmark per job, no co-tenant load), 1 healthy subscriber + k stalled subscribers, 1000-message warmup, 10 000-message measurement window, latencies recorded into an HDR histogram, p99 reported with a 95 % bootstrap confidence interval. Assertion passes if the upper bound of the CI is ≤ 5 ms; if the runner reports it cannot guarantee isolation (e.g., shared CI without the dedicated label), the test SKIPS with a loud message rather than asserting (preventing silent flake).
4. **Tenant-isolation authorization gate** (`packages/shared/auth`). Adversarial cases: tenant A's share-token used to subscribe to tenant B's call → 403; expired token → 403; revoked token → 403 within 1 s of revoke (asserted **without** any verifier-side cache; if cache is added later, this test gains an invalidation case in the same PR); token bound to call X used on call Y → 403; no token, no session → 403; session present but `call_id` not in tenant → 403. Plus a fuzz round (random payloads must never return 2xx).
5. **Multi-call tunnel watchdog (with leader election)** (`apps/ingest`). Red cases: single-process — 2 consecutive failed probes flips region to degraded; warning line appended to every IN_CALL transcript in that region; `calls.ingest_degraded` flips true for every IN_CALL call in the region; recovery appends exactly one recovered line and clears `ingest_degraded`; flapping (fail-pass-fail) does not spam. **Distributed** — 3 ingest replicas race for the advisory lock; only one runs the watchdog; on leader-kill the next replica takes over within ≤ lease + probe interval; warning/recovery lines are emitted exactly once per outage across the cluster.
6. **Magic-link security** (`apps/app-api`). Red cases: token replay after `/auth/callback` consumes it → 401; token used after 15-min TTL elapses (including "clicked at 14:59, consumed at 15:01") → 401; timing-safe comparison on `/auth/callback` (statistical timing test); two concurrent outstanding links for one email — the older is invalidated server-side at issue time, only the newest verifies; per-email rate limit (5/hr) and per-IP rate limit (20/hr) trip independently; tampered KID → 401; signature mismatch → 401.
7. **Webhook authenticity (ingest)** (`apps/ingest`). Adversarial cases: external POST with valid-looking `?bot=<known>&t=<guessed>` but no/invalid Recall signature → 401; valid Recall signature but `?t=` mismatched against `calls.ingest_secret_hash` → 401; valid signature + valid `?t=` but `bot_id` belongs to a tenant the request claims a different `call_id` for → 403 (tenancy gate); replay of a valid webhook body — accepted at most once (Recall delivers at-least-once; we are idempotent via `(bot_id, recall_event_id)`); fuzz of malformed payloads must never reach the normalizer with a partially-valid state.
8. **Bot lifecycle → call status & pickup latency** (`apps/ingest`). Red cases: a silent call (no transcript events for 60 s after `in_call_recording`) still reaches `IN_CALL` solely on Recall lifecycle; **pickup-latency SLO: from Recall delivering `in_call_recording` (synthesized by the in-repo Recall fake) to the per-call page WS emitting the new status, p95 ≤ 1 s** over a 200-call sample; `in_call_not_recording` transitions the call to `COULD_NOT_RECORD` and the bot-worker emits a `leave` but **does NOT post the recording disclosure**; `BOT_REMOVED` while previously `IN_CALL` ends the call cleanly with the right audit entry; `fatal` before `JOINING` produces `COULD_NOT_JOIN` with the Recall reason string surfaced.
9. **Worker registration / discovery** (`apps/bot-worker` + `apps/app-api`). Red cases: app-api can resolve a worker by `call_id` only for calls in its tenant (RLS-filtered); a stale `workers` row whose process is dead returns a connection error that surfaces as a clean 503 to the dashboard (not a hang); per-worker secret mismatch → 401; calls into another tenant's worker via a leaked secret → 403 (tenancy gate runs before the inter-service auth).
10. **Share-scope limits** (`apps/ws-hub`, `apps/app-api`). Red cases: 201st concurrent connection on one share token → 429 with `Retry-After`; 21st client→server command in 60 s on one share connection → 429; 1001st establishment in 60 min on one token → 429; revoke kills all open share connections within 1 s; `read`-scope connections on the same call are unaffected by share-scope limits hitting.

### 6.3 Manual test plan (mirrors §3 stories)
A scripted run-through per story, executed by the team on a staging tenant, recorded as the v0.3 acceptance gate. Story 6 (in-call disclosure) is verified by joining a real test Zoom/Meet and confirming the bot's display name and the on-join chat post on `in_call_recording`, and (separately) by forcing an `in_call_not_recording` scenario (e.g., a meeting where recording is host-blocked) to confirm NO recording chat post fires and the call lands at `COULD_NOT_RECORD`.

## 7. Team (veteran experts to hire)

- **Veteran real-time meeting infrastructure engineer (1)** — Recall.ai integration, bot lifecycle, transcript ingest, regional cloudflared named tunnels, watchdog (incl. leader election). *Lead engineer for the call path.*
- **Veteran backend / API engineer (1)** — app-api, Postgres schema + RLS, token service, capability model, audit log, worker registration.
- **Veteran security engineer (0.5 in v1, 1.0 in v2)** — tenancy gate threat model, magic-link flow review, webhook authenticity (Recall signature + ingest_secret), capability-token design, AI-agent channel design review for v2.
- **Veteran full-stack / Next.js engineer (1)** — marketing site, dashboard, per-call page, WS client, share-link page, degraded-banner UX.
- **Veteran SRE / platform engineer (1)** — Postgres + secret manager + one-region-then-multi-region deploy, cloudflared named-tunnel ops, advisory-lock leader election, on-call playbook, observability dashboards.
- **Veteran product designer (0.5)** — exactly the dashboard + per-call page + share modal; deliberately tiny scope to keep v1 small.

Total v1: 1 + 1 + 0.5 + 1 + 1 + 0.5 = **5.0 FTE**. In v2 the security role goes to 1.0 (+0.5) and the product designer rolls off (−0.5), netting flat at 5.0 FTE for the v2 sprint.

## 8. Implementation plan (sprints, parallelization, ordering)

v1 target: **one week**, three sprints of ~2 days each. Sprints overlap heavily — work is parallelized by track, not gated end-to-end. The v1 launch gate is a single healthy production region; deploying a second region in Sprint 3 proves the multi-region seam but is NOT a launch gate (§4.7).

### Sprint 1 (Days 1–2) — "the seams"
Parallel tracks:
- **Backend (API engineer)** — Postgres schema + migrations (users, tenants, calls (with `ingest_degraded`), transcripts, tokens, audit_log, workers, regions) with RLS. App-api skeleton: `/auth/magic-link`, `/auth/callback`, `/calls` (create + read). **TDD** token generator/verifier and read-vs-share distinction (§6.2 #2). **TDD** tenancy gate (§6.2 #4). **TDD** magic-link security (§6.2 #6).
- **Call-path (meeting infra engineer)** — `packages/shared/transcript` normalizer extracted from CLI, **TDD** (§6.2 #1). Bot-orchestrator skeleton; reuse `src/recall.ts` client; integrate with shared Recall key from secret manager; ingest_secret generation. Stand up first regional cloudflared named tunnel.
- **SRE** — Provision Postgres (managed), secret manager (Recall key + Recall webhook secret + email provider key + KID secret + region webhook secrets), one region's cloudflared named tunnel, CI matrix update including the dedicated benchmark runner used by §6.2 #3.
- **Frontend (full-stack)** — Marketing landing at `samograph.dev`. Magic-link request + callback pages. Dashboard skeleton.
- **Security (fractional)** — Threat model for the tenancy gate; review token shape and KID rotation plan before code lands; review webhook authenticity design (Recall signature + ingest_secret).

*Sprint exit:* a signed-in user can create a `Call` row from a URL; tokens round-trip; tenancy gate has full adversarial test coverage; magic-link security tests pass; one regional tunnel passes the `/health` round-trip.

### Sprint 2 (Days 3–5) — "the live transcript"
Parallel tracks:
- **Call-path** — Ingest service receives Recall webhooks, **verifies Recall signature + ingest_secret** (§5.3), runs normalizer, writes to `transcripts`, publishes to fan-out hub. **TDD** webhook authenticity (§6.2 #7). **TDD** bot lifecycle → call status & pickup latency (§6.2 #8). Multi-call tunnel watchdog with Postgres advisory-lock leader election and `calls.ingest_degraded` overlay, **TDD** (§6.2 #5). Bot-worker command/act API + worker registration, **TDD** (§6.2 #9). In-call disclosure chat post on `in_call_recording` only; `in_call_not_recording` → `COULD_NOT_RECORD` + clean leave (§5.9).
- **Backend** — WS hub (`/calls/:id/stream`) with bounded queues + backpressure + gap frames + `?since_seq` replay from Postgres + **publisher-latency SLO assertion under k stalled subscribers with documented methodology**, **TDD** (§6.2 #3). Share-link mint/revoke endpoints + explicit numeric share limits + `share` scope wiring (distinct from `read`), **TDD** (§6.2 #10). Audit-log writes for bot create/leave, share mint/revoke.
- **Frontend** — Per-call page: live WS, status states driven by Recall lifecycle (JOINING / IN_CALL / ENDED / COULD_NOT_JOIN / COULD_NOT_RECORD / BOT_REMOVED), degraded banner driven by `ingest_degraded` overlay AND warning lines, share modal, Story-4 "Try again" → dashboard with URL pre-filled.
- **SRE** — Activation-funnel dashboard wired to log counters; on-call playbook draft for `INGEST_DEGRADED` overlay, `COULD_NOT_JOIN`, `COULD_NOT_RECORD`; advisory-lock leader-election runbook.

*Sprint exit:* end-to-end happy path works against a real Recall bot on a real Zoom/Meet call; silent-call test reaches `IN_CALL`; share link works, revokes within 1 s, enforces its caps; a forced tunnel outage in staging produces the warning line and clears it on recovery; bot disclosure visible in real call only when actually recording.

### Sprint 3 (Days 6–7) — "harden + ship"
Parallel tracks:
- **All** — Manual test pass of §3 stories on staging (including Story 6 disclosure both for the recording and the non-recording cases).
- **Call-path + SRE** — Deploy a second region behind the same regional-tunnel pattern (proves the multi-region seam; not a launch gate). Region selection policy (§4.7) wired up and exercised in staging only.
- **Backend + Security** — Rate-limit magic-link (5/hr/email, 20/hr/IP, independent), rate-limit bot creation per tenant, rate-limit WS connections per call (distinct caps for `read` vs `share`, with numeric values per §5.7). Final review of tenancy gate, token verifier, webhook authenticity, RLS policies. Magic-link deliverability check against Gmail + at least one corporate mail (SPF/DKIM/DMARC live).
- **Frontend** — Past-calls list, transcript download, terminal failure UX (incl. `COULD_NOT_RECORD` copy), empty/loading states. Final marketing copy.

*Sprint exit:* the v1 acceptance test (§3 stories + W1 activation metric instrumented + pickup-latency SLO observed in staging) passes; deploy to prod behind a public URL with the primary region serving traffic and the second region warm.

### Phase 2 (next, not this week)
A single follow-on sprint adds: agent gateway (HTTP + WS + MCP), `act:*` scopes in the token verifier, per-token rate limits, agent-channel audit-log entries on every act call, dashboard "Connect AI agent" affordance with scope-picker + one-click revoke. Because the bot-worker command/act API, the worker-registration discovery model, and the capability-token model already exist, this should be days, not weeks.

## 9. Success metric

**v1 (single metric):** W1 activation = fraction of new signups who, within their first week, (a) paste a meeting link, (b) get the bot admitted into a real call (Recall lifecycle reaches `in_call_recording`, not first transcript line), (c) and watch ≥30 s of live transcript stream on the per-call page. **Target ≥ 0.5.** Instrumented from the activation funnel dashboard (§5.11). The pickup-latency SLO (event received → status visible p95 ≤ 1 s) is monitored as a secondary health metric (alerts only; not the optimization target).

**v2 (later, do not optimize in v1):** number of active calls with at least one AI-agent connection through the bidirectional channel.

## 10. Open questions / risks

1. **Shared Recall API key — tenant isolation.** Mitigation: the key never leaves bot-orchestrator + ingest; every request flows through the tenancy gate; audit log captures every Recall-mediated action; pen-test the gate before v2 launches the agent channel. Compute-isolation roadmap (hardened containers now → VM-grade microVMs in v2) is §4.8; scheduled key rotation is §4.10.
2. **AI-agent channel security (v2).** Capability-scoped, short-TTL, revocable tokens; rate-limited; full audit; never expose Recall key. Requires explicit security review before v2 ships.
3. **Act-channel abuse (v2).** An agent posting in someone's meeting / grabbing frames must be authorized, logged, and revocable. Per-token rate limits + per-tenant daily caps.
4. **Consent / recording disclosure across two-party-consent jurisdictions.** Addressed at three layers: (a) host-side dashboard disclosure; (b) bot display name `samograph (recording)` visible to all participants; (c) bot posts a single in-call chat disclosure on `in_call_recording` only (NOT on `in_call_not_recording`, where the claim would be factually wrong — §5.9). Legal sign-off still needed before broad launch; not blocking the build-week.
5. **Recall.ai cost guardrails and free-tier limits.** Per-tenant active-call cap + per-tenant minutes/day cap in v1, conservative defaults, surfaced as a friendly error rather than a silent failure.
6. **Tunnel as single point of failure.** One regional named tunnel per region; watchdog with loud warnings; leader-elected so warnings are not multiplied by ingest replica count; multi-region seam built and validated in Sprint 3 (single region remains sufficient for ship).
7. **Magic-link deliverability on corporate mail.** SPF/DKIM/DMARC from day one; warm IP via the transactional provider; explicit "didn't get it?" affordance with re-send + alternate-email entry. Tracked as a launch blocker.
8. **Regional named-tunnel ops.** cloudflared named tunnels require credentials + DNS — captured in the SRE on-call playbook.
9. **MCP endpoint shape for v2.** Spec'd in v2's design doc; v1 only needs the bot-worker command/act API to be MCP-compatible in payload shape (verbs are 1:1 with CLI).
10. **WS reconnect storms.** Bounded queues + `?since_seq` replay mean reconnect is cheap; per-IP connection cap on ws-hub as a safety belt; per-share-token establishment rate (1000/hr) caps fan-out abuse.
11. **Worker process crash mid-call.** v1 surfaces a 503 to the dashboard on owner-action; transcript ingest is independent of bot-worker and keeps flowing. Auto-restart + workers-table reconciliation deferred to v1.1 unless it bites during build-week.
12. **Benchmark-runner availability for §6.2 #3.** The publisher-latency assertion only runs on a CI runner with single-tenant isolation; on shared runners the test skips with a loud message. Risk: if the dedicated runner is unavailable for an extended period, this SLO can drift silently. Mitigation: SRE tracks the runner as a first-class CI dependency.
13. **Billing margin — per-minute cost vs flat per-seat price (v2).** Recall bills per-minute but plans are flat per-seat, so heavy users can be loss-making. Mitigation: fair-use minute caps per seat/month (friendly soft limit), per-tenant margin monitoring, retain the v1 cost guardrails as a floor (§5.15, §10 #5).
14. **Compute isolation is container-grade, not VM-grade, in v1.** Bot-workers run hardened containers (shared kernel), adequate while they run only our code but below a VM boundary — a concern once the v2 agent channel lets external agents drive a worker. Note **Hetzner Cloud has no nested virtualization**, so Firecracker needs Hetzner bare-metal or a managed provider. Mitigation: v2 moves the worker tier to managed Firecracker (Fly.io), gVisor as the no-KVM fallback (§4.8).
15. **Cloudflare as a dependency.** Tunnel is free with no request cap (a real win over ngrok) but has **no SLA below the Business plan**, and Cloudflare had two notable data-plane outages in the research window (Jun & Nov 2025). Mitigation: per-region named tunnels, fail-over to a second tunnel/`--webhook-base`, keep any Worker/Queues/R2 buffering off the critical live path (§4.9).
16. **GDPR / right-to-erasure completeness.** Deleting our copy is not enough — the **Recall-side recording** must also be deleted, and any v2-stored video purged. Mitigation: deletion calls the Recall delete API and cascades to object storage, with a ≤30-day erasure SLA and an audit tombstone (§5.14).
17. **Recall key-rotation correctness.** A botched rotation could break webhooks for in-flight calls. Mitigation: dual-key overlap + drain-before-revoke (bounded by max call length), automated job + runbook, forced-rotation path for incidents (§4.10).

## 11. Changelog (embedded; mirrors changelog.md)

- **v0.4 (2026-06-24)** — Stakeholder feedback round (post-publish). **Tenant compute isolation roadmap (§4.8):** explicit that v1 = RLS (data) + hardened containers (compute, shared-kernel, NOT a VM boundary); v2 moves the bot-worker tier to VM-grade **managed Firecracker (Fly.io Machines)**, with gVisor as the no-KVM fallback and self-hosted Firecracker on **Hetzner bare-metal** as a v3 cost optimization — noting **Hetzner Cloud has no nested virtualization** (researched). **Cloudflare posture (§4.9):** Tunnel is the right (free, no-request-cap, named) ingest choice but has no SLA below Business and a 2025 data-plane-outage history; Cloudflare compute is the wrong shape for long-lived outbound-WS bot-workers (they stay on Hetzner/Fly). **Scheduled secret rotation (§4.10):** Recall API key rotates on a 90-day schedule via dual-key overlap + drain-before-revoke (+ forced incident path); app KIDs/webhook/worker secrets on the same cadence. **RLS InitPlan fix (§5.10):** policies now use `tenant_id = (SELECT current_setting('app.tenant_id'))::uuid` so the predicate is a once-per-statement InitPlan, not a per-row re-eval. **Settings (§5.12):** Look (name/avatar, dynamic vs static presence), Sound (chime library), Dictionary (PostgresFM preset + user keyterms via Deepgram), Language (specific or multilingual, Deepgram), calendar auto-join (v2), retention + privacy — tagged by phase; **Deepgram** named as the transcription engine. **Retention (§5.13):** transcripts indefinite from v1; **video storage = v2** (R2/B2, configurable N-month retention, default 6mo). **Data deletion (§5.14):** per-call + account erasure incl. Recall-side recording delete (GDPR, v1). **Billing (§5.15):** v2 Stripe per-seat subscriptions matching Circleback (Individual/Team/Enterprise, monthly+annual, trial), with a per-minute-cost-vs-flat-price margin guardrail. **Error-code reference (§5.16):** stable `SAMO-…` codes with HTTP/call-status, user-facing copy, and client behavior. Added risks #13–#17 (billing margin, container-vs-VM isolation, Cloudflare dependency, GDPR/Recall-side erasure, key-rotation correctness). Moved billing, calendar auto-join, and video storage from v3 into v2 (§2).
- **v0.3 (2026-06-23)** — Addressed Reviewer B v0.2 findings. **Removed the stale `<!-- architecture:begin -->` placeholder in §3** (this time actually). **Resolved the `read` scope contradiction**: `read` is now explicitly session-derived and NOT persisted in `tokens`; only `share` (and v2 `act:*`) live in `tokens` (§4.2, §5.6, §5.7, §5.10, §6.2 #2). **Fixed the §4.2 cross-reference** to point at §5.7 (capability tokens) instead of §5.6 (tenancy gate). **Fixed §5.9** to post the recording disclosure ONLY on `in_call_recording`; `in_call_not_recording` now drives a terminal `COULD_NOT_RECORD` status and the bot leaves cleanly without a misleading disclosure post. **Modeled `INGEST_DEGRADED` as a boolean overlay column** (`calls.ingest_degraded`) rather than a status-enum value, so an `IN_CALL` call can be degraded simultaneously (§5.2, §5.10, §4.5, §4.6). **Reconciled multi-region timing**: Sprint 3 deploys a second region inside the v1 build-week as a seam-proof, but a single healthy region remains sufficient for ship — multi-region is not a launch gate (§4.7, §8). **Extended WS-fan-out SLO** to k ∈ {1, 4, 16, 32} concurrently stalled subscribers, with explicit benchmark methodology (dedicated isolated runner, HDR histogram, 95 % bootstrap CI, skip rather than flake on shared runners) — §5.5, §6.2 #3. **Added numeric caps for the `share` scope** (200 concurrent connections per token, 20 client→server commands/min/conn, 1000 establishments/hour/token) and matching tests (§5.7, §6.2 #10). **Added explicit pickup-latency SLO** (event received → status visible p95 ≤ 1 s) and a test for it (§3 Story 1, §5.2, §6.2 #8, §5.11). **Corrected team total** to 5.0 FTE (matching the role sum) with security stepping up by 0.5 in v2 as designer rolls off (§7). **Clarified Story 4 "Try again"** to mean "return to dashboard with URL pre-filled; user must explicitly re-submit" (no implicit retry, no auto-created Call row) — §3 Story 4, §5.2.
- **v0.2 (2026-06-23)** — Addressed Reviewer B v0.1 findings. Removed the stale `<!-- architecture:begin -->` placeholder in §3. Made the `read` vs `share` scope distinction concrete (session-bound vs anonymous-link; distinct rate limits, revocation paths, audit attribution). Introduced the `IngestSecret` abstraction and §5.3 webhook authenticity flow (Recall signature + constant-time secret match) — separates the long-lived per-call ingest secret from user-visible `CapabilityToken`s. Added bot-worker service discovery via a `workers` table + per-instance secret (mTLS in prod). Moved `JOINING → IN_CALL` onto Recall bot-lifecycle events so silent calls progress. Pinned numeric defaults (probe interval 20 s; magic-link 5/hr/email + 20/hr/IP independent; queue 256 msgs OR 512 KB; KID 90-day rotation with 30-day overlap). Added explicit publisher-latency SLO (p99 ≤ 5 ms with stalled subscriber) to §5.5 + §6.2 #3. Added watchdog leader election via Postgres advisory lock (§4.6) and distributed-replica test coverage. Added §6.2 #6 magic-link security tests, §6.2 #7 webhook authenticity tests, §6.2 #8 bot-lifecycle status tests, §6.2 #9 worker discovery tests. Committed CI smoke test to in-repo Recall fake + nightly real-Recall job. Committed to no verifier-side token cache in v1. Added §5.9 in-call disclosure (bot name + chat post on join) to address two-party-consent at the participant level. Added §4.7 region selection policy. Qualified Story 1 SLOs.
- **v0.1 (2026-06-23)** — Initial draft. Two-phase scope (v1 zero-setup hosted samograph; v2 secure bidirectional AI-agent channel). Architecture with shared Recall key + regional named cloudflared tunnels + tenancy gate + capability tokens + audit log; v2 seams (bot-worker command/act API, capability-scoped tokens) wired in v1. TDD list for transcript normalizer, capability tokens, WS backpressure, tenancy gate, multi-call tunnel watchdog. 4.5-FTE team, three-sprint one-week plan. W1 activation ≥ 0.5 as the single v1 metric.
