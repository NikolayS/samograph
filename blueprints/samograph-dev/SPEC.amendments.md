# samograph.dev — SPEC Amendments

This document records every **intentional** deviation from or extension to
`blueprints/samograph-dev/SPEC.md`, organized by sprint. Each entry cites the
section it amends, states precisely what differs from a literal reading of the
spec, and explains why. These are reviewed decisions — not silent drift.

> Sections: **[Sprint 1 — "the seams"](#sprint-1--the-seams)** ·
> **[Sprint 2 — "the live transcript"](#sprint-2--the-live-transcript)**.

---

## Sprint 1 — "the seams"

This section records the Sprint-1 ("the seams") deviations.

Genuine bugs/gaps are tracked as GitHub issues, not here. Items deferred to later
sprints (ws-hub, ingest webhook/watchdog, bot-worker, share caps, billing) are
out of scope for this document.

> Status legend: **Extension** = adds something the spec did not specify;
> **Clarification** = narrows/interprets ambiguous spec wording;
> **Superset** = strictly stronger than the spec requires.

---

## 1. §5.16 — New error code `SAMO-CALL-URL` (HTTP 400) — *Extension*

**Amends:** §5.16 (error-code reference), in service of §5.2 (meeting-URL validation).

**What differs:** A new typed error code `SAMO-CALL-URL` (HTTP 400,
`retryable:false`) is defined in `apps/app-api/calls/errors.ts` for meeting-URL
validation rejection on `POST /calls`. The §5.16 table enumerates
auth/authz/token/call-status codes but contains no input-validation class.

**Why:** §5.2 requires app-api to validate `meeting_url` against a known
Zoom/Google Meet pattern *before* creating a `calls` row, but §5.16 provides no
code for that failure. The code is declared with an in-source comment flagging it
as a reviewed extension. User-facing copy: "That doesn't look like a Zoom or
Google Meet meeting link." **Action:** fold this row into the §5.16 table.

---

## 2. §5.6 — `authorizeCall` is the only entry point *for callId-scoped access* — *Clarification*

**Amends:** §5.6 ("every route ... calls `authorizeCall` before touching state").

**What differs:** `POST /calls` (create) and `GET /calls` (list) do **not** call
`authorizeCall`. They authenticate the session directly (`verifySession`) and then
enforce tenancy through the *same underlying primitives the gate's session path
uses* — `SET LOCAL ROLE samograph_app` + `setTenant` + RLS. Only the
callId-scoped `GET /calls/:id` routes through `authorizeCall`.

**Why:** `authorizeCall` is structurally callId-scoped — it authorizes access to
one resource id. Create has no callId yet; list has no single callId. Both reuse
the identical isolation primitives, so the security property is unchanged; the
gate simply is not the natural shape for collection/create endpoints. **Action:**
read the §5.6 "only entry point" wording as "for callId-scoped access."

---

## 3. §5.6 — Gate verifies token without per-action scope enforcement (v2 seam) — *Clarification*

**Amends:** §5.6 (token authorization path).

**What differs:** The gate calls `verifyToken` **without** `requireScope`. It
authorizes any valid, persisted, call-bound token (only `share` in v1; `act:*` is
the v2 seam) and returns its scopes; per-action scope enforcement (e.g. `act:chat`
vs `act:frame`) is left to the route/WS layer.

**Why:** v1 mints only `share`, so call-binding + persistence + tenant scoping
fully determine access. Finer per-action checks are a v2 concern, and the verifier
already supports `requireScope` for when v2 wires them. Intentional seam, not a gap.

---

## 4. §5.10 — Routes run under non-superuser role `samograph_app` + `FORCE RLS` — *Superset*

**Amends:** §5.10 (RLS + InitPlan wrapper).

**What differs:** Every tenant-scoped route transaction runs
`SET LOCAL ROLE samograph_app` (a `NOLOGIN`, non-superuser, non-owner role granted
only SELECT/INSERT/UPDATE/DELETE on the six tenant-scoped tables) in addition to
setting `app.tenant_id`, and migration 0002 applies `FORCE ROW LEVEL SECURITY` so
even a table owner is filtered. `http.db.test.ts` proves cross-tenant denial is
RLS-enforced (not app logic) by contrasting against a superuser connection that
*would* leak the row.

**Why:** §5.10 specifies RLS + the `(SELECT current_setting('app.tenant_id'))::uuid`
InitPlan wrapper but does not explicitly require a distinct non-superuser runtime
role. Running routes under it means a bug in route logic cannot leak across
tenants — RLS still fires. A strictly beneficial superset. **Action:** document the
role/grant model.

---

## 5. §5.10 — `users` and `regions` deliberately excluded from RLS — *Clarification*

**Amends:** §5.10 (RLS coverage).

**What differs:** Of the eight tables, only the six tenant-scoped ones (tenants,
calls, transcripts, tokens, audit_log, workers) ENABLE/FORCE RLS and are granted to
`samograph_app`. `users` and `regions` are intentionally **not** RLS'd and **not**
granted to the runtime role.

**Why:** Neither carries `tenant_id`. `users` is read pre-tenant during
authentication (before any tenant context exists); `regions` is infrastructure
metadata, not tenant data. Applying tenant RLS to either would be incoherent. This
is the correct modeling, not a coverage gap.

---

## 6. §5.2 — Authn (401) vs authz (403) split, both bodyless — *Clarification*

**Amends:** §5.2 / §5.6 / §5.16 (failure responses).

**What differs:** Authentication failures (missing/invalid magic-link token,
missing/invalid session) return **HTTP 401 with no body** under the `SAMO-AUTH-00x`
family. Authorization failures (tenancy gate DENY) return **HTTP 403 with no body**
under `SAMO-AUTHZ-001`. The two are kept as distinct status codes and code
families rather than collapsed.

**Why:** 401 ("who are you?") and 403 ("you may not touch this resource") are
semantically different and map to different client behaviors (re-authenticate vs
hard-stop). Both are bodyless to avoid leaking existence/state to an attacker, per
the fail-closed posture §5.6 mandates. `SAMO-AUTHZ-001` is notably the one §5.16
code living in a shared lib (`packages/shared/auth/gate.ts`, exported as
`AUTHZ_ERROR_CODE`).

---

## 7. §5.7 — `read` is session-derived and never persisted; magic-link, session, and capability tokens are distinct token systems — *Clarification*

**Amends:** §5.7 (capability tokens) / §5.1 (auth) / §5.10.

**What differs:** Three separate credential systems exist with separate shapes and
signing paths: (a) **magic-link tokens** (short-lived 15-min auth, single-use,
`SAMO-AUTH-*`), (b) the **session cookie** (HttpOnly signed, derives the `read`
capability), and (c) **capability tokens** (`tokens` table: `share` in v1, `act:*`
in v2). `read` is *derived from the session and never written to `tokens`* —
`assertPersistableScopes` throws before any row is written for a non-persisted
scope.

**Why:** Resolves the v0.3 `read`-scope contradiction (§4.2/§5.6/§5.7/§6.2 #2):
revoking a read capability is achieved by session expiry/sign-out, so it must not be
a persisted row. Keeping the three systems distinct prevents a compromise of one
keyring from forging another. **Note (prod hardening):** the three keyrings should
use *distinct secrets* (magic-link signer vs session signer vs capability-token
keyring) — tracked as a Sprint-2/prod follow-up.

---

## 8. §6.2 #1 — "Idempotent across reorderings of words" = multiset+speaker+timestamp invariance, **not** order-independent output — *Clarification*

**Amends:** §6.2 #1, in service of §5.4 (byte-identity with the CLI).

**What differs:** `normalizeTranscriptLine` **preserves input word order**
(`words.map(...).join(' ')`); reordering input words *does* change the output
string. `normalizer.test.ts:233-251` re-reads the spec property as: speaker +
timestamp bracket + word **multiset** are invariant under permutation, while
visible order tracks input order.

**Why:** §5.4 requires byte-identity with the CLI, which joins words in array
order, and word order is semantically load-bearing in a transcript. Sorting words to
make output literally order-independent would corrupt real transcripts and break
CLI parity. The literal §6.2 #1 reading is the looser constraint; the
implementation chooses correctness + §5.4 parity. **Action:** clarify the §6.2 #1
wording.

---

## 9. §5.4 — Normalizer returns the canonical line **without** trailing `\n` — *Clarification*

**Amends:** §5.4 (`[...] Speaker: utterance\n`).

**What differs:** `normalizeTranscriptLine` returns the line *without* the trailing
newline shown in §5.4; the caller appends `\n`.

**Why:** Matches the CLI exactly (the CLI writer does `line + '\n'`), preserving
byte-identity and keeping the function pure/composable. The normalizer is the single
source of truth — `src/transcript.ts:74-77` re-exports it as `formatTranscriptLine`,
so parity is structural, not convergent. Cosmetic spec/impl note only.

---

## 10. §5.7 — `constantTimeEqual` short-circuits `false` on length mismatch — *Clarification*

**Amends:** §5.7 (constant-time compare).

**What differs:** `signing.ts` early-returns `false` when buffer lengths differ,
before the `node:crypto.timingSafeEqual` byte compare (which throws on unequal
lengths).

**Why:** HMAC-SHA256 base64url signatures are a fixed 43 chars; the length is public
and fixed, so the short-circuit leaks no secret-dependent timing. The actual byte
compare remains constant-time. Standard, acceptable pattern — recorded for
completeness.

---

## 11. §5.1 — `clientIp()` trusts the first `X-Forwarded-For` hop (trusted-proxy assumption) — *Clarification*

**Amends:** §5.1 (per-IP rate limit).

**What differs:** `clientIp()` derives the client IP from the first
`X-Forwarded-For` hop (then `cf-connecting-ip`, else `'unknown'`).

**Why:** Correct behind the edge/cloudflared tunnel that *overwrites* XFF, which is
the v1 single-region-behind-tunnel topology. If a deployment ever exposes app-api
without a trusted proxy that replaces (not appends) XFF, the per-IP limit could be
spoofed and direct callers would collapse into one `'unknown'` bucket. Acceptable for
v1; the **trusted-proxy assumption must be documented in ops docs** and enforced at
the deployment boundary.

---

## 12. Tooling — `bun.lock` is git-ignored (supply-chain note) — *Known limitation*

**Amends:** (no §; build/CI hygiene.)

**What differs:** `bun.lock` is not committed, so `bun install --frozen-lockfile`
is effectively a no-op and CI does not pin the dependency graph.

**Why:** Carried over from the CLI repo's ignore rules. This is a known supply-chain
weakness, not a deliberate design choice — **tracked as a follow-up to commit a
lockfile and enforce frozen-install in CI.** Recorded here so the gap is visible
until closed.

---

### Cross-reference: Sprint-1 SAMO-* codes actually shipped

Implemented and stable: `SAMO-AUTH-001/002/003/004` (apps/app-api/auth),
`SAMO-AUTHZ-001` (shared auth lib), `SAMO-CALL-JOIN` (web client mapping),
`SAMO-CALL-URL` (new, item 1). All remaining §5.16 codes
(`SAMO-TOKEN-*`, `SAMO-RATE-*`, `SAMO-CALL-NOREC`, `SAMO-CALL-REMOVED`,
`SAMO-INGEST-DEGRADED`, `SAMO-WEBHOOK-401`, `SAMO-WORKER-503`, `SAMO-RECALL-COST`,
`SAMO-BILLING-*`) belong to later-sprint surfaces and are intentionally not yet
implemented.

---

## Sprint 2 — "the live transcript"

This section records the **intentional** deviations from `SPEC.md` made during
Sprint 2 ("the live transcript": webhook ingest → normalizer → WS fan-out → live
read-along page, plus bot lifecycle/disclosure, the multi-call watchdog, share
links, and observability). Same legend (**Extension** / **Clarification** /
**Superset**), plus **Deviation (v1)** = a deliberate v1 simplification with a
tracked follow-up issue for the full behavior. Genuine gaps are tracked as issues
(see *Gaps* at the end), not recorded here as amendments.

---

### S2-1. §5.3 step 4 — webhook cross-tenant check is a 403 on `data.bot_id` vs the authenticated `?bot=` — *Clarification*

**Amends:** §5.3 (validation order) / §6.2 #7.

**What differs:** Steps 1–3 (Recall signature, known `recall_bot_id`, `ingest_secret`)
fail **401** (`SAMO-WEBHOOK-401`); the tenancy gate fails **403** (`SAMO-AUTHZ-001`)
— not §5.3's literal "all four → 401" (already flagged for #77). Additionally, a
webhook carries **no client-supplied `call_id`**, so the spec's "claims a different
call_id" is realized as: the body's self-claimed `data.bot_id` **must equal** the
authenticated `?bot=` (→ `calls.recall_bot_id`). Same threat (spoofing another
tenant's call), expressed on the only identity field the webhook carries.

**Why:** §6.2 #7 / acceptance #4 and §5.16 (where `SAMO-AUTHZ-001` *is* the
cross-tenant 403) require a 403 for cross-tenant; and the webhook's wire shape has
no `call_id` to compare. `apps/ingest/webhook.ts`.

---

### S2-2. §5.4 — `transcripts.text` stores the **utterance only**; `ts`/`speaker` are split out losslessly — *Clarification*

**Amends:** §5.4 (canonical line) / §5.10 (transcripts shape).

**What differs:** The append-only `transcripts` row stores `text` = the utterance
only, with `ts` and `speaker` split out of the canonical `[ts] speaker: text` line
via `splitCanonicalLine` (the inverse of the normalizer). Re-rendering is
byte-identical to the CLI even when the speaker contains `": "` or unicode
(asserted across 10 adversarial inputs).

**Why:** Matches the merged `TranscriptLine` shape consumed by web and the RLS
seed, while preserving §5.4 byte-identity. `apps/ingest/transcriptPipeline.ts`.

---

### S2-3. §6.2 #8 — pickup latency is measured handler-entry → status-frame-published (virtual clock), not a live WS round-trip — *Clarification*

**Amends:** §6.2 #8 (pickup-latency SLO).

**What differs:** `pickup_latency_ms` is measured from `bot.status_change` handler
entry to just after the status frame is published, under an **injected virtual
clock** over a 200-call sample (p95 ≤ 1 s) — not a wall-clock browser round-trip.

**Why:** "status-visible" is operationalized as "status frame published" (the last
server-side step before fan-out); a virtual clock makes the SLO deterministic, not
flaky. `apps/ingest/botLifecycle.ts::observePickupLatencyMs`.

---

### S2-4. §4.1 — v1 composes ingest + ws-hub in **one process** with an in-process after-commit bridge — *Deviation (v1)*

**Amends:** §4.1 (separate ingest / ws-hub services).

**What differs:** v1 runs ingest and ws-hub in a single process; transcript lines
cross from ingest to the Hub via an in-process after-commit bridge rather than a
cross-process Postgres `LISTEN`. The `PgListenNotifyPublisher` already emits the
`{call_id, seq}` signal, so the future process split is a drop-in.

**Why:** Bun's built-in SQL has no `LISTEN`/`NOTIFY` consumer API and a `postgres`
dependency cannot be added under `--frozen-lockfile`. Auth + RLS are unchanged and
verified through the composition. `apps/ws-hub/liveBridge.ts`, `server.ts`.

---

### S2-5. §5.5 — WS `idleTimeout` capped at 255 s; long silences recovered via `?since_seq` — *Deviation (v1)*

**Amends:** §5.5 (live stream).

**What differs:** Bun caps `Bun.serve` `idleTimeout` at 255 s, so a stream idle past
that closes; the client reconnects with `?since_seq=<last-seen>` and the exact
missing range replays (no data lost). No app-level keepalive ping yet.

**Why:** Platform limit; losslessness is preserved by the existing replay path.
Keepalive ping tracked as a follow-up. `apps/ws-hub/server.ts`.

---

### S2-6. §3 Story 5 / §5.5 — degraded **banner** is live via `ingest_degraded`; the inline `SAMOGRAPH-WARNING` **line** is not yet live-forwarded — *Deviation (v1)*

**Amends:** §3 Story 5 / §5.5 (degraded surfacing).

**What differs:** Transcript **lines** flow live, but **control frames** (status +
the `SAMOGRAPH-WARNING` line) are not forwarded over the WS in the one-process
bridge (the fan-in re-hydrates persisted lines by seq and drops `ctl` signals). The
degraded **banner** still works (the watchdog flips `calls.ingest_degraded`, read
from Postgres), and **§6.2 #5 is unbroken** (the watchdog still degrades + warns).
The inline warning *line* doesn't appear in the live stream until reload.

**Why:** Consequence of the one-process bridge (S2-4); the "loud, never silent"
guarantee is preserved by the banner. Live control-frame forwarding tracked as
**#106**.

---

### S2-7. §3 Story 2 / §5.7 — share viewers pass `callId={shareToken}`; the Hub resolves the call from the token — *Clarification*

**Amends:** §3 Story 2 / §5.7 (share connections).

**What differs:** `ShareCallView` passes the share token as the path `callId` to
`PerCallTranscript`; for a share connection the path id is advisory and the ws-hub
resolves the actual call from the token itself (the read-only route never exposes
the real call id or any owner control).

**Why:** A share viewer must not need (or learn) the owner's call id; the token is
the capability. `apps/web/components/ShareCallView.tsx`.

---

### S2-8. §5.7 — share-cap key is `sha256(shareToken)`; default share-token TTL is 30 days — *Clarification*

**Amends:** §5.7 (share caps + token lifetime).

**What differs:** The per-token rate/concurrency caps (200 conns / 20 cmds-per-min /
1000 establishments-per-hr) are keyed on `sha256(shareToken)` (a stable identity
that never holds the raw secret), and the share token's default TTL is 30 days.

**Why:** Avoids retaining the raw secret in the limiter and avoids widening the
gate's return type; §5.7 pins **KID rotation**, not the share TTL, so 30 days is a
chosen default, not a deviation from a pinned value. `apps/ws-hub/caps.ts`.

---

### S2-9. §5.5 / §5.7 — the ≤ 1 s revoke-close is driven by the per-connection recheck timer in the ws-hub **server**, not the stream core — *Clarification*

**Amends:** §5.5 / §5.7 (revoke latency).

**What differs:** `apps/ws-hub/stream.ts` exposes `recheck()` + `RECHECK_INTERVAL_MS`
but is transport-agnostic; the periodic re-authorization that closes a revoked
socket within ≤ 1 s is wired in the `Bun.serve` server (#104). The guarantee holds
end-to-end (verified live), but it lives at the server layer by design.

**Why:** Keeps the stream core transport-free and testable; the timer belongs to the
running server. `apps/ws-hub/server.ts`.

---

### S2-10. §5.2 / §5.3 / §6.1 — real Recall behind `RECALL_LIVE` (issue #88) — *Extension*

**Amends:** §6.1 (the deterministic fake is the default), §5.2 / §5.3 (the createBot
webhook URL), §5.9 (bot display name + Deepgram real-time transcription).

**What differs / is added:**
- **Flag seam.** `apps/bot-orchestrator/recallClient.ts` adds `getRecallClient()`. The
  DEFAULT stays the deterministic in-repo fake (§6.1) — CI/local need NO key. The REAL
  `src/recall.ts` client is reached ONLY when `RECALL_LIVE` (canonical) **or** its
  `RECALL_AI` alias (the wording in issue #88) is truthy **AND** `RECALL_API_KEY` is set.
  The flag is never set in CI. Flag on + no key → a clear **startup** error, never a
  silent fallback (validated at dev-server boot via `liveRecallClient()`).
- **Configurable public webhook base.** `publicWebhookBase()` reads `PUBLIC_WEBHOOK_BASE`
  (e.g. `https://samograph-main.samo.cat`) and `orchestrateJoin` accepts a `webhookBase`
  override (defaulting to the regional tunnel base). This is the seam that lets a real bot
  on a public VM register an operator-controlled ingress (§5.3). A set-but-non-https value
  fails fast.
- **Registered webhook URL carries `?t=` only, not `?bot=&t=`; ingest resolves the call by
  the ingest secret.** Recall assigns `recall_bot_id` only in the createBot **response**, so
  the realtime endpoint URL we register at creation cannot embed `?bot=<id>`. We register
  `…/webhook?t=<ingest_secret>` (the proven `src/commands/join.ts` pattern) and the
  orchestrator still records the canonical `?bot=<id>&t=<secret>` form (§5.3) on the call row
  once the id is known. **The §5.3 ingest front door (`apps/ingest/webhook.ts`) is extended
  to resolve the owning call by `?t=` when `?bot=` is absent** — `pgLookupCallByIngestSecret`
  keys on `sha256(t) = calls.ingest_secret_hash` (indexed by migration `0005`); finding the
  row BY that hash IS the §5.3 secret match, so the constant-time `?t=` compare (step 3) is
  not re-run for that path. This works for BOTH `transcript.data` (which has NO body
  `bot_id`) and `bot.status_change`, because the `?t=` is always in the URL query. **Step 1
  (the Recall signature vs the per-region webhook secret) still gates FIRST, fail-closed**;
  the canonical `?bot=&t=` path is unchanged. *(NB: an earlier draft said ingest resolves
  the bot "from the body" — that was wrong; `transcript.data` carries no body `bot_id`, so a
  `?t=`-only URL without this ingest change would 401 and the bot would join but be deaf.)*
- **Deepgram real-time transcription** is enabled in the createBot payload
  (`recording_config.transcript.provider.deepgram_streaming`), and the bot display name is
  the fixed `samograph (recording)` (§5.9), both reusing the CLI's proven shape.

**Why:** Lets the owner watch an ACTUAL bot join a Zoom/Meet call without disturbing the
fake-by-default CI gate. Live transcript end-to-end remains a SEPARATE concern — it
additionally needs the public webhook tunnel reachable (the sprint-exit manual gate); this
seam gets a real bot INTO the call AND makes the `?t=`-registered webhook deliverable to
ingest. `apps/bot-orchestrator/recallClient.ts`, `apps/bot-orchestrator/index.ts`,
`apps/app-api/dev-server.ts`, `apps/ingest/webhook.ts`,
`packages/shared/db/migrations/0005_calls_ingest_secret_hash_idx.sql`,
`docs/runbooks/real-recall-flag.md`.

---

### S2-11. §5.3 — the Recall webhook signature is OPTIONAL; `?t=` ingest_secret is the primary auth — *Correction/Deviation (v1)*

**Amends:** §5.3 step 1 ("Recall webhook signature verified … Rejects external spoofs").

**What differs:** §5.3 lists the Recall HMAC signature as the **required first gate**. But
Recall's **real-time** webhooks (the per-bot `realtime_endpoints` that carry `transcript.data`
and `bot.status_change`) are **NOT HMAC-signed** — verified against the proven CLI, which
authenticates its webhook by the **URL token only** and no signature
(`src/server.ts`: `POST /webhook?token=<secret>` → `tokensEqual(searchParams.get("token"), webhookToken)`;
no HMAC anywhere). Requiring a signature would therefore **401 every real webhook** — the bot
joins but is deaf. So `apps/ingest/webhook.ts` now treats the signature as **optional
defense-in-depth**: if a signature header is **present** (e.g. an account-level Svix webhook)
it MUST verify — a present-but-forged one is rejected (401 `bad_signature`) before any DB
touch; if **absent** (the real-time path) it is NOT rejected. The **primary, required** gate
is the per-call **`?t=` ingest_secret** — a 256-bit secret we generate and embed in the
webhook URL handed to Recall — matched constant-time (`?bot=` path) or as a hashed indexed
lookup (`?t=` path, S2-10). An attacker omitting the signature gains nothing: they still need
the secret.

**Security invariant (unchanged):** nothing dispatches without a valid `?t=` secret — a
well-formed spoof with a wrong/absent secret is rejected (`unknown_bot`/`ingest_secret_mismatch`),
and a malformed body is dropped before the normalizer even on the authenticated path
(fuzz-tested both ways in `apps/ingest/webhook.test.ts`).

**Tradeoff (accept for v1, matches the CLI):** the secret rides in the URL query, so it can
appear in ingress/proxy access logs. Mitigations in place: HTTPS transport, a per-call
(not global) secret, and only the SHA-256 hash is persisted (§4.2). A follow-up could move
the token to a request header; not a v1 blocker. `apps/ingest/webhook.ts`.

---

### Gaps tracked as issues (NOT amendments)

Per this document's rule, genuine gaps/follow-ups are GitHub issues, not amendments:

- **#105** — real `apps/app-api` §4.1 Hono entrypoint (replace the Sprint-1
  `dev-server.ts` stopgap).
- **#106** — live-forward control frames (status + `SAMOGRAPH-WARNING` line) over WS
  (see S2-6).
- **#107** — `bot_join_total{result}` counter has no producer.
- **#108** — wire `MetricsRegistry` into running servers + mount `/metrics` (no live
  dashboard feed today).
- **#109** — provision the `samograph-bench-isolated` CI runner so the §6.2 #3
  p99 ≤ 5 ms SLO actually asserts (it currently skips loudly).
- **#88** — *optional* real-Recall env flag (a real bot joins) — **implemented**
  (see S2-10): `RECALL_LIVE` + `RECALL_API_KEY`; default stays the fake. Live
  transcript end-to-end still needs the public webhook tunnel (sprint-exit gate).

---

### Cross-reference: Sprint-2 SAMO-* codes now shipped

Implemented and stable in Sprint 2: `SAMO-WEBHOOK-401` (ingest auth),
`SAMO-AUTHZ-001` (cross-tenant 403, shared lib — also used by the webhook gate),
`SAMO-WORKER-503` (dead/stale worker), `SAMO-RATE-001` (share caps, 429 +
Retry-After), `SAMO-CALL-NOREC` / `COULD_NOT_RECORD` and `SAMO-CALL-REMOVED` /
`BOT_REMOVED` (lifecycle), `SAMO-INGEST-DEGRADED` (watchdog overlay), and
`SAMO-CALL-JOIN` (the `COULD_NOT_JOIN` reason, persisted via migration 0004). Still
intentionally not implemented (v2 surfaces): `SAMO-RECALL-COST`, `SAMO-BILLING-*`.