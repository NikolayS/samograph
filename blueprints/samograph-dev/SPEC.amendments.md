# samograph.dev — SPEC Amendments

This document records every **intentional** deviation from or extension to
`blueprints/samograph-dev/SPEC.md`, organized by sprint. Each entry cites the
section it amends, states precisely what differs from a literal reading of the
spec, and explains why. These are reviewed decisions — not silent drift.

> Sections: **[Sprint 1 — "the seams"](#sprint-1--the-seams)** ·
> **[Sprint 2 — "the live transcript"](#sprint-2--the-live-transcript)** ·
> **[Sprint 3 — "multi-region"](#sprint-3--multi-region)** ·
> **[Sprint 4 — "hosting & polish"](#sprint-4--hosting--polish)** ·
> **[Sprint 5 — "post-v1"](#sprint-5--post-v1)**.

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

## 11. §5.1 — `clientIp()` derives the client IP from a trusted header (trusted-proxy assumption) — *Clarification*

**Amends:** §5.1 (per-IP rate limit).

**What differs:** `clientIp()` derives the client IP from the trusted
`cf-connecting-ip` header when present, falling back to the leftmost
`X-Forwarded-For` hop only when it is absent (else `'unknown'`). The leftmost XFF
hop is treated as **untrusted** — behind Cloudflare (the v1 edge), which *appends*
to XFF, that hop is fully client-controlled.

**Why:** Preferring `cf-connecting-ip` (set by the trusted edge, unforgeable by the
client) makes the per-IP limiter key STABLE under a rotating spoofed
`X-Forwarded-For`, closing the email-bombing / send-amplification bypass of the
20/hr per-IP cap. If a deployment ever exposes app-api without a trusted edge that
sets `cf-connecting-ip` (or overwrites XFF), the XFF fallback could be spoofed and
direct callers would collapse into one `'unknown'` bucket. The **trusted-proxy
assumption must be documented in ops docs** (docs/runbooks/trusted-proxy.md) and
enforced at the deployment boundary.

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

**Update (#106, partial):** `{type:"status"}` control frames ARE now
live-forwarded — the fan-in publishes them onto the Hub's control lane
(outside the data caps) and the stream serializes the client's
`{type:"status", status}` event, so the per-call page reflects status changes
(ingest lifecycle AND the #118 status poller, which NOTIFYs the same
`{k:"ctl",frame}` signal on `transcript:<call_id>`) without a reload. The
inline `SAMOGRAPH-WARNING` line + `degraded` live lanes remain the deviation.

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
Recall's **real-time** webhooks (the per-bot `realtime_endpoints`, which carry `transcript.data`
only — see S2-12) are **NOT HMAC-signed** — verified against the proven CLI, which
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

### S2-12. §5.2/§5.3 — Recall real-time endpoints accept transcript events ONLY; `bot.status_change` is invalid there — *Correction/Deviation (v1)*

**Amends:** S2-10 (the createBot payload) and S2-11 (which described the real-time
endpoint as carrying `transcript.data` + `bot.status_change`).

**What differs:** the real-Recall createBot payload (`buildRealCreateBotPayload` in
`apps/bot-orchestrator/recallClient.ts`) registered its real-time `webhook` endpoint with
`events: ["transcript.data", "bot.status_change"]`. **Verified against REAL Recall, this is
rejected with HTTP 400** — `"bot.status_change" is not a valid choice` for a real-time
endpoint. Recall's real-time endpoints accept **transcript events only**; `transcript.data`
is valid, `bot.status_change` is NOT. The endpoint `events` array is now **exactly
`["transcript.data"]`**, matching the proven CLI shape (`src/commands/join.ts`, which never
registered `bot.status_change` on the webhook endpoint). This was the only change to the
payload — Deepgram provider, `bot_name` (`samograph (recording)`, §5.9), and the `?t=` webhook
URL are unchanged.

**Consequence — live call-status auto-advance is a SEPARATE follow-up.** Because the real-time
endpoint no longer (and never validly could) carry `bot.status_change`, **with real Recall the
call status will NOT auto-advance yet** (the §5.2 lifecycle that drives `calls.status`
transitions from `bot.status_change` — `apps/ingest/botLifecycle.ts` — receives no such events
over the real-time channel). Delivering Recall status changes needs a **separate status /
account-level webhook config** (not the real-time endpoint), which is tracked as its own
follow-up. Transcript delivery (`transcript.data`) is unaffected; the bot joins and transcript
ingest works. `apps/bot-orchestrator/recallClient.ts`, `apps/bot-orchestrator/recallClient.test.ts`,
`docs/runbooks/real-recall-flag.md`.

---

### S2-13. §3 Story 1 / §5.2 / §5.5 / §6.2 #8 — live call-status is surfaced by a client-side poll, not a cross-process WS status push — *Deviation (v1)*

**Amends:** §3 Story 1 / §5.2 / §5.5 / §6.2 #8 (live status surfacing).

**What differs:** The per-call page reflects status changes with a **client-side
poll** — the page `GET`s `/calls/:id` roughly every **4.5 s** while the call is
non-terminal — instead of the spec'd cross-process WebSocket status push. The
server-side status-frame path still exists but works **only in-process**.

**Why:** Bun's built-in SQL has no `LISTEN` consumer API (see S2-4), so a
cross-process WS status push never reaches an open page — the push silently goes
nowhere (a bug the samorev gate caught on the Sprint-2 consolidation). The client
poll is the reliable surfacing path across the one-process bridge. Tracked under
**#106**. `apps/web/components/PerCallTranscript.tsx`.

---

### S2-14. §5.9 / §6.2 #8 — in-call disclosure idempotency via a durable `calls.disclosure_posted_at` marker (send-then-stamp), not an in-transaction guard — *Deviation (v1)*

**Amends:** §5.9 / §6.2 #8 (exactly-once in-call recording disclosure). Migration
`0006_calls_disclosure_posted_at.sql`.

**What differs:** The §5.9 in-call recording disclosure is made idempotent by a
durable `calls.disclosure_posted_at` marker using a **send-then-stamp** sequence:
the disclosure is sent **outside** the status-flip transaction, then the marker is
stamped. This replaces an in-transaction guard. A duplicate disclosure is therefore
possible but **bounded to the send↔stamp window**.

**Why:** With the disclosure send inside the transaction, a post-send rollback
re-posted the disclosure on every poller sweep (at-least-once — another bug the
samorev gate caught). Sending outside the tx and persisting a durable marker makes
the common path exactly-once and bounds any duplicate to the narrow send↔stamp
window. `apps/bot-orchestrator/statusPoller.ts`.

---

### S2-15. §4.5 — the tunnel-outage watchdog probes a public `/health` route (Caddy → ingest) that returns the §4.5 health marker — *Extension*

**Amends:** §4.5 (tunnel-health probe).

**What differs:** The tunnel-outage watchdog probes a **public `/health` route**
(added to Caddy, routed through to ingest) that returns the §4.5 health marker,
rather than an internal-only check.

**Why:** The watchdog must exercise the same public ingress path Recall's webhooks
traverse to detect a broken tunnel; a reachable public `/health` route returning the
§4.5 marker is what makes the probe meaningful end-to-end.
`apps/ingest/tunnelWatchdog.ts`, `apps/ingest/server.ts`.

---

### S2-16. §5.2 / §5.9 — `COULD_NOT_RECORD` escalates ONLY from `PENDING`/`JOINING`; it can never regress a live `IN_CALL` row — *Clarification*

**Amends:** §5.2 / §5.9 (status lifecycle on `in_call_not_recording`).

**What differs:** `COULD_NOT_RECORD` is only reachable from `PENDING` or `JOINING`.
A mid-call `in_call_not_recording` event no longer flips a live `IN_CALL` row to the
terminal `COULD_NOT_RECORD` status (and so no longer ejects the bot from an
in-progress call).

**Why:** An aged/late `in_call_not_recording` event could destructively regress a
LIVE `IN_CALL` call to terminal `COULD_NOT_RECORD` and eject the bot (a third bug the
samorev gate caught). Scoping the escalation to `PENDING`/`JOINING` preserves the
"terminal is sticky, forward-only" lifecycle invariant. `apps/ingest/botLifecycle.ts`.

**Status — implemented + tested (`fix/botlifecycle-status-guard`).** Each transition
now carries its own explicit `allowedFrom` set instead of the shared `NON_TERMINAL`
guard, and `applyTerminal`'s `WHERE status IN (…)` is scoped to it:
`in_call_not_recording` (COULD_NOT_RECORD) and `fatal` (COULD_NOT_JOIN) are
`allowedFrom = ['PENDING','JOINING']` (pre-join only — from `IN_CALL` a NO-OP, so the
bot is never ejected mid-recording and a recorded call is never mislabelled), while
`call_ended` (ENDED) and `bot_removed` (BOT_REMOVED) keep `['PENDING','JOINING','IN_CALL']`
(a live call CAN end / be removed). Red/green coverage in
`apps/ingest/botLifecycle.test.ts`: `IN_CALL` + `in_call_not_recording` stays `IN_CALL`
with NO `worker.leave` and no status frame; `IN_CALL` + `fatal` stays `IN_CALL`; and the
preserved paths (`PENDING` + `in_call_not_recording` → `COULD_NOT_RECORD` + leave;
`IN_CALL` + `call_ended` → `ENDED`; `IN_CALL` + `bot_removed` → `BOT_REMOVED`).

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

---

## Sprint 3 — "multi-region"

This section records the **intentional** deviations/clarifications from `SPEC.md`
made during Sprint 3 (the multi-region seam: region-selection policy code, plus
the prod-ingress clarification). Same legend (**Extension** / **Clarification** /
**Superset** / **Deviation (v1)**). Per §8, deploying a 2nd region is *proof of the
seam*, not a launch gate; in this build the multi-region **code** lands while the
2nd-region **deploy** is deferred to the owner post-launch — so the shipped default
keeps the single-region prod path unchanged.

---

### S3-1. §4.3 / §4.5 / §4.9 — "named tunnel per region" is a dev artifact + an *optional* prod security posture, **not** a functional requirement of prod ingress — *Clarification*

**Amends:** §4.3 ("Why one named regional tunnel…"), §4.5 (tunnel watchdog probe
target `https://<regional-tunnel>/health`), §4.9 (Cloudflare posture) — and the
downstream docs that repeat "named tunnel per region" as *the* prod path
(`docs/runbooks/README.md`, `docs/runbooks/ingest-degraded.md`,
`docs/samograph-dev/brief.html`).

**What differs.** The SPEC body presents a cloudflared **named tunnel per region**
as *the* production webhook-ingress mechanism. As actually built and operated, the
tunnel is one of three distinct things, only one of which is a functional
requirement:

1. **Dev-only artifact (the real driver).** A developer's laptop is not publicly
   reachable, so a tunnel (ngrok/cloudflared quick tunnel, or a named tunnel) is
   how Recall's webhooks reach a local ingest during development. This is the
   origin of the whole "tunnel" language and mirrors the CLI's `--tunnel`.
2. **Prod ingress = plain public HTTPS (the functional requirement).** In
   production, ingest sits behind a normal public HTTPS endpoint (Caddy → ingest;
   see S2-15) at **one static `/webhook` path**, with per-call routing carried in
   the query string `?bot=<recall_bot_id>&t=<ingest_secret>` (verified at the
   tenancy gate, §5.3). A publicly reachable HTTPS `/webhook` is all Recall needs;
   `webhook_url` is built from `PUBLIC_WEBHOOK_BASE`/`webhookBase` when set
   (`apps/bot-orchestrator/index.ts` `publicWebhookBase`, issue #88), otherwise
   from the region's configured base. There is **no per-call** ingress object.
3. **Named tunnel in prod = OPTIONAL hardening, not required.** Running that public
   `/webhook` *behind* a cloudflared **named** tunnel is a legitimate,
   recommended-when-desired security posture — it yields **zero inbound open ports**
   on the host and puts Cloudflare's edge (DDoS/WAF/TLS) in front of ingest. But it
   is a *deployment choice*, not a functional prerequisite: a plain public HTTPS
   `/webhook` (e.g. Caddy with a real cert, security-group-restricted) is equally
   correct. §4.9 already frames the tunnel as free/no-request-cap and explicitly
   says *"fail over to a second tunnel/`--webhook-base`"* and keep Cloudflare off
   the hard critical path — i.e. the tunnel is a posture, not a hard dependency.

**Why.** The "named tunnel per region" framing conflates a *dev-reachability
workaround* and an *optional edge-security posture* with the actual *functional*
requirement, which is simply **a public HTTPS `/webhook` reachable by Recall, with
per-call params**. Reading it as a hard requirement would (a) wrongly imply
Cloudflare is on the critical live path (it must not be — §4.9, risk #15) and
(b) wrongly imply per-region tunnels are load-bearing for correctness rather than
an ops/security convenience. The per-region **watchdog** (§4.5/§4.6) and the
region-selection policy (§4.7, S3-2) operate over whatever public ingress a region
uses; "regional tunnel `/health`" in §4.5 should be read as "the region's public
`/health` marker route" (already realized that way in S2-15).

**Docs touched.** Non-invasive pointers were added referencing this amendment where
the docs still assert named-tunnel-per-region as THE prod path — the SPEC body and
runbook/brief wording are **not** rewritten (the SPEC stays the contract): §4.3,
§4.5, §4.9 (`SPEC.md`), `docs/runbooks/README.md`, `docs/runbooks/ingest-degraded.md`,
`docs/samograph-dev/brief.html`.

---

### S3-2. §4.7 — region-selection policy implemented as a configurable, injectable policy defaulting to single healthy `us-east` — *Extension*

**Amends:** §4.7 (region selection policy).

**What differs.** `apps/bot-orchestrator/index.ts` now implements the §4.7 policy
in `pickRegion(opts)` over a **configurable** region set (`RegionHealth[]` =
`{region, healthy, latencyMs}`), sourced from injected deps or env
(`regionsFromEnv` reads `SAMOGRAPH_REGIONS`), and **defaulting to
`DEFAULT_REGIONS` = the single healthy `us-east`** so production behavior is
UNCHANGED until a 2nd region is deployed. Selection is exactly §4.7:

- **(a) user-pinned override** wins — honored only when that region is present and
  **healthy**; a pinned region that is unknown or **degraded fails closed** and
  falls through to (b) with a `region_pin_skipped` log (a new call is never sent to
  a degraded region, even a pinned one).
- **(b) lowest-latency HEALTHY region**, with **deterministic round-robin** within
  a latency tie (tied set ordered by region name, indexed by an injected
  `tieBreaker` cursor mod tie-count — same input ⇒ same output).
- A **degraded** region **fails closed** (filtered out; never chosen for a new
  call); when any region was skipped, the chosen alternative is logged
  (`region_selected {chosen, skipped}`). All-degraded throws (no healthy target).

`orchestrateJoin`'s existing `deps.region` is retained as a **hard override** that
bypasses the policy entirely (operator/testing escape hatch); when absent the
policy chooses. The `publicWebhookBase`/`webhookBase` seam (issue #88) is unchanged.

**Not migrated:** already-`IN_CALL` calls in a region that later degrades are **not**
moved (Recall has no cross-region bot migration, §4.7) — a deliberate non-action;
they keep surfacing the §4.5 warning until recovery.

**Deferred (owner, post-launch):** the actual **2nd-region deploy** + a live
health/latency source feeding `regionsFromEnv`/deps. The code + tests land now; the
deploy is not a launch gate (§8). `apps/bot-orchestrator/index.ts`,
`apps/bot-orchestrator/index.test.ts`.

---

## Sprint 4 — "hosting & polish"

This section records the **intentional** deviations/extensions from `SPEC.md` made
during Sprint 4 (hosting the build on the 3-tier preview→prod topology, plus the
product-surface polish that ships with v1): incoming meeting chat folded into the
transcript, the "Greenroom" design system, per-env host derivation for callbacks
and webhooks, an encoded DB bootstrap for the non-superuser login role, and the
3-tier deploy machinery. Same legend (**Extension** / **Clarification** /
**Superset** / **Deviation (v1)**). Genuine gaps/follow-ups stay GitHub issues, not
amendments.

---

### S4-1. §5.4 — incoming meeting chat is folded into the transcript, rendered `Name (chat):`; backed by `transcripts.kind` (`'speech'|'chat'`) — *Extension*

**Amends:** §5.4 (transcript normalizer / canonical line), which is speech-only.
Migration `0008` adds `transcripts.kind`.

**What differs:** §5.4 defines the transcript as a stream of spoken utterances
(`[ts] Speaker: utterance`). v1 additionally ingests **incoming meeting chat**
messages and folds them into the same transcript stream, rendered distinctly as
`Name (chat): message` so a reader can tell a typed chat line from a spoken one.
Persistence carries the discriminator: migration `0008` adds a `kind` column to
`transcripts` (`'speech' | 'chat'`, defaulting to `'speech'`), so speech and chat
share the append-only table and ordering but stay distinguishable on read. The
transcript **download** endpoint gains a with/without-comments toggle so an export
can include or exclude the chat lines (#197).

**Why:** In real calls, substantive content (links, names, questions) arrives in the
meeting chat, not only in speech; dropping it made the transcript lossy. Folding it
into the one ordered stream — rather than a second parallel surface — keeps the live
read-along and the export coherent, while `kind` preserves the speech/chat
distinction end-to-end. **PRs:** #189 (CLI), #196 (hosted), #197 (download
with/without comments). `apps/ingest/transcriptPipeline.ts`, `apps/ws-hub/fanIn.ts`,
`apps/web/lib/transcriptView.ts`.

---

### S4-2. §2 / §8 — a named "Greenroom" design system, beyond the bare "marketing landing" — *Extension*

**Amends:** §2 (scope phases) / §8 (implementation plan), which scope the product
surface as a bare "marketing landing" plus the app.

**What differs:** v1 ships a named **"Greenroom"** brand/design system rather than an
unstyled landing: a white/green palette with **rationed pink** accents, full
**light + dark** design tokens, and a shared component styling layer. It spans design
tokens + core styling (#179), the landing **hero** (#183), **dashboard** polish
(#155), and a **robot avatar** for the bot's presence identity (#177). The SPEC
names only a marketing landing; the design system, tokenized theming, and the
dashboard/avatar polish are additive product surface.

**Why:** A coherent, themeable visual identity is what makes the hosted product feel
shippable and is cheap to carry as tokens rather than one-off CSS; light/dark tokens
also keep the live pages legible in both modes. No SPEC behavior changes — this is
presentation-layer scope beyond the literal "landing." **PRs:** #179 (tokens + core
styling), #183 (landing hero), #155 (dashboard polish), #177 (robot avatar).

---

### S4-3. §5.1 / §5.3 — magic-link callback and the Recall webhook are registered against the **per-env host**, preferring a trusted per-env `BASE_URL` over the prod-pinned var — *Extension*

**Amends:** §5.1 (magic-link callback URL) and §5.3 (webhook ingest) / S2-10
(`publicWebhookBase`).

**What differs:** Under the 3-tier deploy (S4-5), a request can land on any of prod,
`samograph-main`, or a branch preview host. Two outbound URLs that were previously
pinned to the prod host are now derived from the **per-env host**:

1. **Magic-link callback (§5.1).** The auth callback link now targets the host the
   request arrived on instead of unconditionally bouncing to prod, so a login begun
   on a preview completes on that same preview (#191).
2. **Recall transcript webhook (§5.3 / S2-10 `publicWebhookBase`).** The webhook URL
   registered with Recall is built against the per-env host, so a bot launched from a
   preview delivers `transcript.data` back to *that* preview's ingest, not prod
   (#194).

Both prefer a **trusted per-env `BASE_URL`** (set by the deploy for the env) over the
prod-pinned variable, falling back to the pinned value only when the per-env one is
absent.

**Why:** With prod-pinned URLs, a preview would send its login callbacks and its
webhook deliveries to prod — breaking preview auth and routing a preview bot's
transcript to the wrong environment. Deriving from a per-env, deploy-set `BASE_URL`
makes each tier self-contained. The per-env value must be **set by the trusted
deploy** (not client-derived) to stay unforgeable, consistent with the trusted-proxy
posture (amendment #11). **PRs:** #191 (callback host), #194 (webhook host).

---

### S4-4. §5.10 / amendment #4 — a superuser, idempotent `bootstrap.sql` encodes the non-superuser `samograph_app` login-role wiring; a test reproduces prod's non-superuser topology — *Superset*

**Amends:** §5.10 (data model / RLS runtime role) and **amendment #4** (routes run
under the non-superuser `samograph_app` role).

**What differs:** Amendment #4 established that tenant-scoped routes run under a
`NOLOGIN`, non-superuser `samograph_app` role, but the wiring that *provisions* that
role in a real deployment was previously assumed/manual. v1 encodes it as a
**superuser-run, idempotent `bootstrap.sql`**: it provisions the login role and its
grants — GRANT of the `samograph_app` role membership onto the actual **login** role,
plus `BYPASSRLS` on that login role — so the runtime topology is reproducible rather
than hand-applied. A test reproduces **prod's non-superuser topology** (connecting as
the non-superuser login role, not a superuser) so the RLS/role behavior is verified
against the shape prod actually runs, not a superuser shortcut (#187).

**Why:** Amendment #4's guarantee only holds if the role/grant wiring is actually in
place; leaving it manual meant prod could drift from the tested shape (and a
superuser test connection would mask an RLS gap — exactly what amendment #4's own
`http.db.test.ts` warns about). Encoding it in an idempotent bootstrap and testing
against the non-superuser login role closes that gap and makes the deployment
reproducible. Strictly beneficial superset. **PR:** #187. `bootstrap.sql`.

---

### S4-5. §4.3 / §8 — a 3-tier preview→prod deploy model via samohost `.samohost.toml` (tag→prod / main→preview / branch→DBLab-clone preview) — *Extension*

**Amends:** §4.3 (single named-tunnel regional ingress) / §8 (implementation +
launch plan) — partially anticipated by **S3-1** (tunnel = posture, not the
functional requirement).

**What differs:** The SPEC frames deployment as a single-region tunnel'd ingress. v1
adds a **3-tier preview→prod** deploy model, declared in-repo via `.samohost.toml`
and driven through CI:

- a **release tag** (`v*`) → **production** (`samograph.samo.team`, prod DB);
- **merge to `main`** → the canonical **main preview** (`samograph-main.samo.cat`,
  its own DBLab clone);
- **push to any dev branch** → an **ephemeral branch preview**
  (`samograph-<branch>.samo.cat`) on its own **DBLab thin-clone**, torn down when the
  branch is merged/deleted.

Prod deploys **only on a tag**, never on a `main` or branch push. **PRs:** #171,
#172, #185.

**Scope note — the tag-gate register is a control-plane operator step, not in-repo.**
`.samohost.toml` and the CI triggers are in the repo, but the samohost control-plane
side that *registers/enforces* the tag→prod gate (the operator wiring on the VM that
decides a given tag is allowed to cut prod over) lives on the host, outside this
repo. The in-repo artifacts declare the topology; the operator step provisions it.

**Why:** Hosting the build for owner testing needs isolated, production-like
environments per branch/PR without touching live prod, and a prod cutover that is
deliberate (tag-gated) rather than an accidental consequence of a merge — the exact
mapping the root `CLAUDE.md` deployment-topology section calls the target. DBLab
thin-clones make per-preview databases cheap. This realizes S3-1's reading (the
functional requirement is a reachable public ingress, over whatever topology the env
uses) as concrete deploy machinery. **PRs:** #171, #172, #185. `.samohost.toml`.

---
### S4-6. §5.12 — hosted Settings v1 surface: default dictionary preset is `none` (opt-in PostgresFM), plus a `dictionary_preset` field — *Clarification*

**Amends:** §5.12 (Settings → Transcription → Dictionary / keyterms).

**What differs:** §5.12 says the PostgresFM preset "ships" alongside user-defined
terms. The v1 hosted implementation models this as TWO persisted fields — a
`dictionary_preset` (`none` | `postgresfm`) plus the tenant's own `keyterms` — and
defaults a new tenant's preset to **`none`** (opt-in), not `postgresfm`. The effective
Deepgram keyterms passed at bot-create are the preset's terms layered UNDER the user
terms (user terms first so the 100-keyterm cap never drops them), deduped. Language
default stays `multi` (multilingual auto-detect) and the chime default is `blip`
(= `DEFAULT_CHIME`), matching the pre-settings hardwired behavior.

**Why:** "Ships" means selectable, not force-on. A neutral default (empty keyterms,
multilingual) keeps a first GET's defaults crisp and unsurprising, and makes the
dictionary an explicit tenant choice; the PostgresFM preset is one click away. The
shared model reuses `src/dict.ts` (`loadDict`) and `src/chime.ts` rather than forking
them. Settings flow per-tenant into the Deepgram config at bot-create (keyterms +
language), realizing the §5.12 "cheap Recall/Deepgram passthrough". **Migration:**
`0010_settings.sql` (tenant-scoped table + RLS/FORCE RLS + InitPlan-wrapped policy).

---

## Sprint 5 — "post-v1"

This section records the **intentional** deviations from `SPEC.md` made *after* v1
shipped (v0.8.0). Same legend (**Extension** / **Clarification** / **Superset** /
**Deviation (v1)**), plus **Deviation (post-v1)** = a documented v1 non-goal that is
deliberately reversed once v1 is out, with owner sign-off. That status exists for
exactly one reason: §1 requires that the v1 non-goals are never *silently*
re-introduced, so reversing one is an amendment, not a commit.

---

### S5-1. §1 / §2 / §5.1 / §5.11 / §5.12 / §5.14 / §5.16 / §9 — sign up & sign in with Google (OIDC) — *Deviation (post-v1)*

**Amends:** §1 (the "Explicit non-goals for v1 (do not silently re-introduce)"
paragraph, which names "no Google OAuth"), §2 v1 ("Email magic-link auth only
(passwordless)"), §5.1 (auth), §5.11 + §9 (activation funnel + the W1 target),
§5.12 (Settings), §5.14 (erasure), §5.16 (error-code reference). Issue **#209**.
Migrations `0011_user_identities.sql` and `0012_users_signup_method.sql`.

> **Citation note.** The "no Google OAuth" non-goal lives in **§1**, not §2 — §2's
> corresponding statement is the v1 bullet "Email magic-link auth only
> (passwordless)". Both are amended here; the §1 sentence is the one that carries
> the "do not silently re-introduce" obligation this entry discharges.

**What differs:** §1 lists "no Google OAuth" among the explicit v1 non-goals that
must "not [be] silently re-introduce[d]". This amendment **REVERSES that non-goal
for post-v1** — deliberately, in writing, and with owner sign-off — and records
exactly how far the reversal goes and where it stops.

1. **§1 / §2 / §5.1 — a second credential path, never the only one.** Google
   OAuth 2.0 / OIDC sign-in is added alongside magic link, with the same
   auto-provisioning semantics §5.1 already has (completing auth for an unknown
   email creates the account; for a known one, signs into it) and terminating in
   the **same `samo_session` cookie** the magic-link path mints — one cookie mint
   site, no second session shape. **Magic link stays enabled on every environment
   where Google is enabled**, so Google is never the only credential on any
   deployment: a revoked, suspended or deleted Google account always leaves the
   user a working recovery path into their own tenant. The flow is a confidential
   authorization-code client with **PKCE S256** and a **nonce**, terminating in a
   **locally verified RS256 ID token** (full `alg`/`iss`/`aud`/`azp`/`exp`/`iat`/
   `nonce` verification against cached JWKS) — the OIDC Core 3.1.3.7
   direct-channel exemption is deliberately **not** taken, because this design
   introduces a fake-IdP seam and that exemption stops holding the moment the
   exchange can be swapped.
2. **§5.1 — identity is keyed on `(provider, provider_subject)`, NOT on
   `users.email`.** A new privileged `user_identities` table (migration `0011`;
   no RLS and no `samograph_app` grant, exactly like `users` and `magic_links`,
   because the callback runs before any tenant context exists) is the identity
   key. Resolution order is itself the security property: a `(provider, sub)` hit
   resolves the user and **does not consult email at all**; email is used only on
   the miss branch, to link to an existing account. Email-keyed identity was
   rejected because it produces four concrete failures — a Google-side email
   change silently locks a user out of her own tenant; a **reassigned** corporate
   address walks a new holder into the previous holder's tenant on a legitimately
   verified token; a consumer and a Workspace account carrying the same address
   as two distinct `sub`s collapse into one account with no record; and the new
   address may already be `UNIQUE`-taken by someone else.
3. **§5.1 — `users.email` becomes IMMUTABLE after creation.** This is the
   invariant that makes (2) safe: no `UPDATE users SET email` exists anywhere, so
   a Google-side email change is a **no-op** rather than a silent lockout, and a
   reassigned Workspace address cannot re-point an existing account. The
   provider-asserted email is written only to `user_identities.email`, for audit.
4. **§5.1 — `idToken.email_verified === true` is a hard, boolean-strict
   precondition for touching any store.** `users.email` is `UNIQUE` and
   `createOrLoadUser` upserts on it, so `createOrLoadUser(idToken.email)` without
   this gate is a one-line account-takeover endpoint against every existing
   magic-link user. Read **only** from the locally verified ID token — never from
   `userinfo` or any other Google side channel — and enforced in the service
   **before** any store call. On `false`, absent, the string `"true"`, or the
   number `1`: create nothing, link nothing, mint no cookie → `SAMO-AUTH-009`.
   The fallback is **FAIL**, not "then create a new user": creating would squat
   the victim's address before they ever sign up.
5. **§5.1 — same-email linking to an existing magic-link account is SILENT, and
   is therefore paired with a mandatory one-time notification email** on the
   link-to-existing branch (never on new-user, never on returning). Since **no
   session revocation exists anywhere in this system** (sign-out is a cookie
   clear; a session is a 30-day stateless HMAC), that email is the only mechanism
   by which a successful takeover would ever be noticed. Email normalization is
   trim + lowercase only, identical to the magic-link path — explicitly **no**
   Gmail dot/plus canonicalization, which is a cross-user collision (and so a
   takeover primitive) on non-Gmail domains.
6. **§1 / §5.12 — the CALENDAR non-goal is NOT reversed.** Scopes are
   **`openid email` only**. `profile` is not requested, no refresh token is
   requested (`access_type=online`), and no access token is stored. The §5.12 v2
   "calendar auto-join" row must request calendar scopes **INCREMENTALLY from
   Settings, at the moment the user enables it — never bundled into sign-in**,
   because bundling would convert a non-sensitive-scope app into a
   **sensitive-scope** one requiring Google review, and would put a scope the
   user never asked for on the sign-in consent screen. The minimum scope set is
   simultaneously the trust decision and the ship-date decision: `openid` and
   `email` are non-sensitive, so the client publishes with no Google security
   assessment and no restricted-scope review.
7. **§5.11 / §9 — funnel stage 2 is renamed `magic_link_clicked` →
   `auth_completed`** (arity stays 5, so the cumulative index math is unchanged).
   `magic_link_clicked` is derived from a **consumed `magic_links` row**; a Google
   signup never produces one, and `aggregateFunnel` counts each user at every
   stage up to their furthest, so a Google user who creates a call would have
   stage 2 **IMPUTED** — the metric would not visibly break, which is worse than
   breaking. For the first full week after Google ships, the **§9 `≥ 0.5`
   activation target is judged against `method="magic_link"`** and the blended
   number is reported but not targeted, then re-baselined — one-click signup
   raises the denominator faster than the numerator, so the headline metric can
   fall while the product improves.

   **Shipped in issue #222** (this item was written with the Google sequence but
   landed in none of its seven PRs, so the imputation was live on `main` at
   `334cac8`). What exists now:

   - **`FUNNEL_STAGES[1] === "auth_completed"`** (`packages/shared/observe/funnel.ts`).
     The DB feed (`apps/app-api/metrics/funnelSource.ts`) emits it for a consumed
     `magic_links` row **OR** a `user_identities` row — either credential path
     finishing. A `users` row with **neither** is still not counted at stage 2:
     issue #180 provisions the user *before* consuming the link, so a failed
     consume leaves exactly that state, and it is the population that proves the
     fix is not a blanket `+1`.
   - **`samograph_funnel_stage{stage,method}`** — **per-method series only**;
     there is deliberately **no** unlabelled series, so a dashboard cannot sum
     the blend and the split together and double-count. `sum by (stage)` recovers
     the blend exactly. Cardinality is fixed at 5 stages × 2 methods = 10 series,
     every one rendered every scrape (zeroed, never absent).
   - **`samograph_activation_w1_by_method{method}`** — `gauge`, one series per
     method, always rendered. `samograph_activation_w1` stays the unlabelled
     blended gauge, which is what makes the §9 re-baselining rule above readable:
     the blend can fall while both per-method series hold.
   - **`samograph_magic_link_status{status}`** — `gauge`, one series per
     `MagicLinkStatus` (`outstanding` / `consumed` / `superseded`), counted from
     `magic_links` on the same periodic refresh that recomputes the funnel and
     published through the registry. Statuses with no rows report an explicit `0`.
   - **`auth_google_start_total`** and **`auth_identity_linked_total`** —
     `counter`, **no label**, and therefore rendered unconditionally *including at
     0*: "Google has silently linked nobody to an existing account" is a fact the
     dashboard must be able to read, and an absent series is indistinguishable
     from a broken scrape. `auth_identity_linked_total` counts the item-5
     silent-link branch and nothing else (never a new user, never a returning
     signer) — it fires on exactly the same condition as the notification email,
     so the metric and the email can never disagree.
   - **`auth_google_callback_total{result}`** — `counter`, `result` is `ok` or the
     §5.16 code, incremented once at a single exit point.
   - **`users.signup_method`** — migration `0012_users_signup_method.sql`:
     `text NOT NULL DEFAULT 'magic_link' CHECK (signup_method IN ('magic_link',
     'google'))`. Written **on creation only**, by both credential paths
     (`AuthService.callback` passes `magic_link`; `GoogleAuthService` passes
     `google` on the create branch). `PostgresUserStore.createOrLoadUser`'s
     `ON CONFLICT ... DO UPDATE` **omits** the column, so linking a second
     credential to an existing account never rewrites it — the same immutability
     `users.email` has under item 3, and for the same reason: a later sign-in is
     not a re-signup, and silently reclassifying historical cohorts would make
     every week-over-week comparison a lie. The `DEFAULT` doubles as the
     **documented backfill** for pre-`0012` rows: every one of them was a
     magic-link signup by construction, because Google sign-in had never been
     enabled on an environment with real users.
   - The domain lives in **three** places by necessity — the `CHECK` in `0012`,
     `SignupMethod` in `apps/app-api/auth/types.ts` (the owner), and the metric
     label list in `packages/shared/observe/funnel.ts` (the shared layer may not
     import from an app). The last two are pinned to each other by a
     **compile-time** mutual-assignability check in
     `apps/app-api/auth/stores.test.ts`, so they cannot drift silently.
   - **Deviation from the issue's acceptance criterion 2.** #222 AC2 expects a
     second Google-only user with no call to leave `auth_completed` at `1`. That
     contradicts the same issue's in-scope item 1 (stage 2 is emitted for a
     `user_identities` row), under which such a user **has** completed auth and
     counts at stage 2. Item 1 won, because it is the semantically correct
     reading. The anti-`+1` discrimination AC2 exists to provide is preserved and
     asserted instead by the `x1` fixture in
     `apps/app-api/metrics/funnelSource.db.test.ts` — a `users` row with neither
     credential row, which keeps `auth_completed` strictly below `signup`.
   - **Operator note — this rename is a breaking metric change.** Any dashboard
     or recording rule scraping `samograph_funnel_stage{stage="magic_link_clicked"}`,
     or the unlabelled `samograph_funnel_stage{stage="…"}`, returns nothing after
     this deploy. The committed Grafana artifact
     (`docs/observability/activation-funnel.dashboard.json`) is updated in the
     same PR; **`SPEC.md` §5.11 (`:371`) still names the old stage in prose and is
     deliberately untouched here — issue #225 owns that fold-in.**
8. **§5.12 — Settings gains a read-only "Sign-in" block** listing linked methods
   (`magic_link` always; `google` when an identity exists; the `google` row is
   omitted entirely on environments where connecting is impossible). It is the
   direct counterpart of (5): once we attach a Google account to an existing user
   without asking, the user acquires a right to *see* that it happened.
   Connect/disconnect from Settings are deferred `[POSTPONED post-v1]`.

   **SHIPPED (#223).** `GET /settings` gained a third top-level key beside
   `settings` and `options`:

   ```json
   "signin": {
     "email": "owner@example.com",
     "identities": [{ "provider": "google", "connected_at": "2026-03-04T09:15:00.000Z" }]
   }
   ```

   `identities` is ALWAYS an array — `[]` for a magic-link-only account, never
   `null` and never an absent key, so "not connected" is a fact the UI read
   rather than a shape it guessed. `email` is `users.email` (immutable,
   authoritative, the address magic links go to); `user_identities.email` is
   provider-asserted and is **never** served, and neither is `provider_subject`
   (the identity key, and personal data) or `last_login_at`. `PUT /settings` is
   untouched in both directions — its request document and its
   `{settings, options}` response are unchanged.

   The read lives in `apps/app-api/settings/signin.ts` and runs on the
   **privileged** connection, scoped by `user_id` from the verified session
   claims — NOT inside the `SET LOCAL ROLE samograph_app` transaction the
   settings document uses, which would `42501` against the ungranted, RLS-free
   `users`/`user_identities` (0011). Same split as the §5.14 erasure. Because no
   RLS sits behind it, cross-user isolation is asserted directly against real
   Postgres (`apps/app-api/settings/signin.db.test.ts`).

   The UI is `SignInBlock` in `apps/web/components/SettingsPage.tsx`: a
   `<section aria-label="Sign-in">` **outside** the settings `<form>`, with rows
   carrying `data-provider="magic_link"` / `"google"` and zero buttons, inputs,
   selects or links. `magic_link` is rendered unconditionally (item 1 guarantees
   it on every environment). The `google` row renders only when
   `GET /auth/providers` answers `{"google": true}` — a `false` **or a failed
   probe** takes the omit branch, which is why the client's probe is wrapped in a
   `catch` that resolves to the omit branch even though the contract says it
   cannot reject.
9. **§5.14 — erasure must additionally delete `user_identities`.** The §5.14
   account erasure writes an `audit_log(action='account_deleted')` tombstone and
   **never deletes the `users` row** (verified: `apps/app-api/account/http.ts`
   purges `calls`/`transcripts`/`tokens`/`workers`/audit detail only), so the
   `user_identities → users` FK cascade never fires and a Google `sub` — personal
   data — would otherwise survive "erase all my data". The delete runs on the
   **privileged** connection, outside the `SET LOCAL ROLE samograph_app`
   transaction, because the table is deliberately ungranted and the RLS-scoped tx
   would `42501`.
10. **§5.16 — five new codes, plus two pre-existing undocumented rows.** See the
    table below. `SAMO-AUTH-004` is broadened to cover the Google start bucket,
    and `SAMO-AUTH-500` is reused rather than given a Google-specific twin, so
    retryable-infra semantics stay in one place.
11. **Branding deviation.** Google's button spec mandates Roboto Medium 14px; we
    ship `var(--font-body)` at 14px/500 because this app loads no webfonts and
    will not start loading one for a single button. Every other branding
    requirement (the approved label string `Continue with Google`, the unmodified
    four-colour mark, 4px radius, 40px min height, the approved colour sets, no
    extra content inside the button) is honored exactly. The mark's four brand
    hexes live as literal fills in the TSX, which `test/greenroom-tokens.test.ts`
    does not scan — a **documented exception**, not an oversight.

**§5.16 rows to fold into the table.** `SAMO-AUTH-005` and `SAMO-AUTH-500` already
exist in `apps/app-api/auth/errors.ts` and were never documented — drift closed
here. Failures on the Google path occur during a **browser redirect** and so
cannot carry a JSON body: they are delivered as `302 → /auth?error=<CODE>` and
rendered from the same code→copy map the magic-link page already uses.

| Code | HTTP / call status | Meaning | User-facing message | Client behavior |
|---|---|---|---|---|
| `SAMO-AUTH-005` | 401 + clear-cookie | Stateless session outlived its tenant (#114 / §5.14 erasure, or a recreated dev DB) | "You've been signed out. Please sign in again." | Re-authenticate |
| `SAMO-AUTH-500` | 500 | Infra/provisioning failure **after** a valid credential verified (e.g. the pre-tenant `INSERT INTO tenants` errors — #180). The single-use link is left OUTSTANDING | "Something went wrong on our end — please try again." | Retryable — click again |
| `SAMO-AUTH-006` | `302 → /auth?error=…` | User cancelled at Google's consent screen (`error=access_denied`) | "Sign-in cancelled. Choose a way to sign in below." (info tone, not an error) | None — offer both sign-in options again |
| `SAMO-AUTH-007` | `302 → /auth?error=…` | OAuth state / PKCE / nonce failure: tampered or missing `__Host-samo_oauth`, wrong `v`, expired (>10 min), or state mismatch | "That sign-in attempt expired — please try again." | Restart sign-in |
| `SAMO-AUTH-008` | `302 → /auth?error=…` | Google-side or token/ID-token failure (token exchange, JWKS, signature, `iss`/`aud`/`exp`/`nonce`) | "Google couldn't sign you in right now." | Retry, or use magic link |
| `SAMO-AUTH-009` | `302 → /auth?error=…` | `email_verified` is not boolean `true` on the verified ID token | "Your Google account's email isn't verified." | Verify with Google, or use magic link |
| `SAMO-AUTH-010` | `302 → /auth?error=…` | Google sign-in is not configured on this deployment (branch previews, by design) | "Google sign-in isn't available here." | Use magic link |

**PINNED by the implementing PR (issue #209, PR 5).** `AUTH_ERRORS` in
`apps/app-api/auth/errors.ts` records `httpStatus: 302` for all five of
`006`–`010`, because a redirect is the only way any of them is ever delivered:
they are decided while the browser is mid-redirect between us and
`accounts.google.com`, with no fetch to answer in JSON and no page of ours
rendering yet. Recording a 4xx would record a status we never send.
`retryable` is `true` for `006`/`007`/`008` (try again, or use magic link) and
`false` for `009`/`010` (clicking again changes nothing until Google verifies the
address, or until an operator configures credentials on that environment).

`SAMO-AUTH-004` is also reused on both Google legs (`start` and `callback` each
have their OWN 20/hr/IP bucket, separate from the magic-link per-IP budget so
neither credential path can exhaust the other's). On this path it too is
delivered as `302 → /auth?error=SAMO-AUTH-004`, **not** as the 429 + `Retry-After`
that `POST /auth/magic-link` returns — a 429 carrying a `Location` is a dead end
for a browser that arrived by clicking a link. Its `AUTH_ERRORS` row is unchanged
(429), since that is the status of its original, JSON-answering call site.

The user-facing strings in the table above are the SHIPPED strings: they are
asserted byte-for-byte on both sides — `apps/app-api/auth/errors.test.ts` and
`apps/web/lib/authErrors.test.ts` — because a silent edit to either is a
user-visible drift.

None of `006`–`010` distinguishes "this email exists in our DB" from "it does
not" — the split is "your browser/tab went stale" vs "Google's side failed" vs
"your own Google email is unverified", which is not a fact about our user table
and materially changes what the user does next. The security constraint is applied
*inside* each bucket instead: sub-reasons are indistinguishable, and Google's
`error` / `error_description` is **never** reflected into a URL, a response body,
or a rendered log (Google's token endpoint reflects request parameters back).

**Why:** the v1 non-goal was a **scope** decision made to ship the core loop, not a
security or architectural objection — nothing in §4 or §5 was designed around the
absence of a second credential. Google sign-in removes the highest-friction step in
the §5.11 funnel, and it gives the "my magic link never arrived" user an escape
hatch that **§10 #7** (magic-link deliverability on corporate mail, a tracked
*launch blocker*) currently leaves as a dead end. Reversing it in writing, with the
scope boundary in (6) held, is the honest way to take that back; doing it in a
commit message would be exactly the silent re-introduction §1 forbids.

**Explicitly accepted and recorded rather than fixed here:**

- **No session revocation anywhere.** A Google-linked session stays a 30-day
  stateless HMAC regardless of Google-side revocation, password change, or account
  deletion — exactly as a magic-link session already is. Mitigated only by the
  link-notification email in (5). Fix when session revocation lands.
- **Branch previews have no Google sign-in, by design.** Google exact-matches
  `redirect_uri` with no wildcards, and an unbounded set of preview hostnames must
  never be registrable redirect targets. `GET /auth/providers` returns
  `{"google": false}` there and the button does not render; magic link — the same
  credential every preview already has — keeps working. Two OAuth clients
  (`samograph-prod`, `samograph-nonprod`) rather than one, so a leaked preview
  credential cannot mint anything prod accepts (the verifier pins `aud`). The
  fixed-host broker/bounce that *would* give previews Google sign-in is a separate
  issue with its own threat model. See `docs/runbooks/google-oauth.md`.
- **State is single-use only by virtue of Google's authorization code being
  single-use**, inside a 10-minute window. No server-side burn.
- **Duplicate accounts from Gmail dot/plus variants are accepted** — see (5).
- **Workspace domain reassignment** (an ex-employee's address handed to a new hire)
  carries exactly the exposure magic link already carries, since the new hire also
  receives mail at that address. Not a new risk class.
- **The state cookie reuses `SESSION_SECRET`**, domain-separated by a mandatory
  `"samo.oauth.state.v1|"` prefix in the signing input, because three protocols in
  this repo already share the `base64url(json).base64url(hmac)` wire shape and a
  fourth signed under the same key with the same input would be cross-verifiable.
  Accepted cost: rotating `SESSION_SECRET` invalidates in-flight logins inside a
  10-minute window. A dedicated secret was rejected in part because
  `.samohost.toml`'s `secrets` array is a per-env **generator** — see the runbook.

**Status: ABSORBED** — every edit the Action block below asks for has landed in
`SPEC.md` (issue **#225**, PR **#231**): §1 non-goals + §2, §5.1, the §5.11 funnel
rename and `method` label, the §9 re-baselining sentence, the §5.12 "Sign-in" row,
`user_identities` in the §5.14 erasure list, and the §5.16 rows `005`, `006`–`010`
and `500`. The gating precondition ("once the implementing PR pins their log
statuses and copy") was discharged by **#218** (`334cac8`). The Action text is kept
verbatim below as the record of what was owed — it is no longer a to-do.

**Action:** fold the §5.16 rows above into the SPEC's table (including the two
`005`/`500` drift rows) once the implementing PR pins their log statuses and copy;
rename stage 2 in the §5.11 funnel list and add the `method` label; add the §9
re-baselining sentence; add the §5.12 Settings "Sign-in" row; extend the §5.14
erasure list with `user_identities`; and amend the §1 non-goals sentence to record
that "no Google OAuth" was reversed post-v1 by this amendment (the calendar
non-goal is untouched). **Operator setup:**
[`docs/runbooks/google-oauth.md`](../../docs/runbooks/google-oauth.md).

---

### S5-2. §5.14 — account erasure RELEASES the owner's email address; the tombstone keeps no address — *Extension*

**Amends:** §5.14 (delete account and erase all tenant data), in service of §5.1
(sign-in) and S5-1 item 9. Issue **#220** (follow-up to **#218** / **#209**).
Migration `0013_release_erased_account_emails.sql`.

**What differs:** §5.14 erasure is a **tombstone** erasure — the tenant's rows are
purged, one `audit_log(action='account_deleted')` row is written, and the `users` +
`tenants` rows are deliberately RETAINED so `tenantActive` can revoke every
stateless session cookie. As written, the retained `users` row kept the person's
real email address indefinitely. From this amendment on, `DELETE /account` also
**releases that address**: the retained row's `email` is rewritten to the
deterministic, non-routable `deleted-<user id>@deleted.invalid` (RFC 2606 reserved
TLD), in the SAME privileged transaction that deletes the owner's
`user_identities` rows. Migration `0013` backfills tombstones written before this
shipped. Everything else about the tombstone contract is unchanged: the `users`
and `tenants` rows still exist, the `account_deleted` row is still the durable
erasure record, `tenantActive` still returns `false`, and a session cookie over an
erased tenant still 401s `SAMO-AUTH-005` + clear-cookie.

**Why:** retaining the address made the erasure both *incomplete* and *reversible*.

1. **Incomplete.** An email address is directly-identifying personal data. Keeping
   it forever on a row whose only remaining purpose is to say "this account is
   gone" is exactly the retention the right to erasure ends. The erasure record
   needs the tenant id and the actor id, not the address.
2. **Reversible — the actual #220 defect.** `users.email` is UNIQUE and **every**
   sign-in path resolves by address. While the tombstone still carried the
   address, `PostgresUserStore.findByEmail` HIT it, so the Google callback's
   miss branch (`google-service.ts`) linked a **new `user_identities` row to the
   erased account** — re-creating the provider `sub` that S5-1 item 9 had just
   gone to the trouble of deleting — and fired `sendIdentityLinked` at the erased
   address, telling a person who deleted their account that a Google account had
   just been attached to it. The magic-link path's `createOrLoadUser` upsert
   adopted the same corpse, minting a session that then 401s on every route.
   Releasing the address removes the match, so **no sign-in path can reach an
   erased account at all** — one fence, inherited by both credentials, rather than
   a per-path guard that the next credential path would have to remember.

**Why release rather than refuse.** The alternative was a tombstone check in
`google-service.ts` returning a new `SAMO-AUTH-0xx` "this account was deleted"
code. It fixes the two privacy halves, but it makes the tombstone a **permanent
blocklist keyed on the person's own address**: someone who exercised their right
to erasure could never use the product again with that email, on any path — and
the row retained to enforce that is itself the personal data they asked us to
delete. Releasing the address serves the same person better and satisfies the
requirement more completely: a returning user is provisioned a **genuinely fresh**
`users` + `tenants` pair with no history and no link to the erased tenant, instead
of being silently re-attached to erased remnants. It also needs **no new §5.16
code** and no new web copy row.

**Consequences, stated explicitly:**

- **Signing up again on a previously-erased address is ALLOWED**, and produces a
  brand-new empty tenant. It grants no access to erased data (there is none) and
  no access to the erased tenant (a different `tenant_id`, still tombstoned).
- **The magic-link path is fixed by the same change**, with no code change of its
  own: `createOrLoadUser` no longer finds the erased row, so the pre-existing
  "live cookie over a dead tenant" outcome (#114-adjacent, older than #218)
  disappears for erased accounts.
- The `account_deleted` audit row keeps `actor = user:<uuid>`, so the erasure
  stays attributable and auditable without retaining an address.
- Residual, narrow: the address release commits in a second transaction, after the
  RLS-scoped tombstone transaction. A crash strictly between them leaves an
  over-retained address (and, since both live in that one transaction, the
  identity rows too) — the same class of window §5.14's multi-step erasure already
  has, now no wider than it was.

**Status: ABSORBED** — the one edit the Action block below asks for has landed in
`SPEC.md` §5.14 (issue **#225**, PR **#231**): the erasure list now records the
`users.email` release to `deleted-<user id>@deleted.invalid` alongside S5-1 item 9's
`user_identities` entry, and that a previously-erased address may be used to sign up
again. §5.1's identity note names this as the single exception to "no authentication
or identity-linking path mutates `users.email`". The Action text is kept verbatim
below as the record of what was owed — it is no longer a to-do.

**Action:** when §5.14 is folded into the SPEC (issue **#225**), extend the
erasure list with "the owner's `users.email` is released to
`deleted-<user id>@deleted.invalid`" alongside S5-1 item 9's `user_identities`
entry, and record that a previously-erased address may be used to sign up again.

---

### S5-3. §1 / §5.12 / §5.14 / §5.16 — incremental Google Calendar connection and upcoming-meetings cache — *Extension*

**Amends:** §1 (calendar non-goal), §5.12 (Calendar), §5.14 (account erasure), and §5.16 (stable errors). Issue **#240**.

**What differs:** The remaining calendar non-goal is partially reversed. A signed-in owner may connect Google Calendar from Settings and see a cached list of upcoming meetings in the app. This is a separate, incremental OAuth grant: Google sign-in remains exactly `openid email`, requests no Calendar access, stores no Google sign-in token, and remains usable without Calendar. The Calendar flow requests `https://www.googleapis.com/auth/calendar.events.readonly` only when the owner presses “Connect Google Calendar” in Settings, with PKCE, `access_type=offline`, `include_granted_scopes=true`, and `prompt=consent`.

The Calendar refresh token is encrypted at rest with AES-256-GCM under a versioned environment key. A Calendar connection belongs to the consenting `user_id` and is held in a privileged, non-RLS credential table; normalized cached events belong to the tenant and are protected by forced tenant RLS. The cache stores only the event identity, title, organizer address, time range, the current user’s response status, recurrence identity, and a validated Google Meet or Zoom URL. Raw descriptions, locations, attendee lists, access tokens, and Google API payloads are not retained.

A background poller refreshes access tokens in memory and reconciles the next 30 days of the primary calendar into the cache. A revoked or scope-deficient grant is marked broken and surfaced as “Google Calendar needs to be reconnected”; it is not retried until reconnection. Disconnect deletes the local connection and event cache and makes a best-effort call to Google’s token-revocation endpoint.

§5.14 account erasure additionally purges `calendar_events` and the owner’s privileged `calendar_connections` row, including the encrypted refresh token and all connection metadata. Erasure makes a best-effort Google token-revocation request before deleting the local credential; Google unavailability never prevents local erasure.

This amendment does **not** ship calendar auto-join. §5.12’s organizer/internal/external/declined and per-event opt-out rules remain deferred to a follow-up issue. The cached event model and the manual `POST /calls` application-service seam must permit that follow-up to schedule an event without bypassing URL validation, Recall cost controls, tenant settings resolution, audit logging, or enqueue behavior.

The stable Calendar errors added to §5.16 are:

| Code | HTTP / delivery | Meaning | User-facing copy |
|---|---:|---|---|
| `SAMO-CALENDAR-001` | 503 JSON | Calendar OAuth is unavailable on this deployment | “Google Calendar isn’t available here.” |
| `SAMO-CALENDAR-002` | 302 query | Calendar consent was cancelled or denied | “Google Calendar wasn’t connected.” |
| `SAMO-CALENDAR-003` | 302 query | Calendar OAuth state is invalid, expired, mismatched, or belongs to another session | “That Google Calendar connection expired. Please try again.” |
| `SAMO-CALENDAR-004` | 302 query | Calendar code exchange failed or supplied no refresh token | “Google Calendar couldn’t be connected. Please try again.” |
| `SAMO-CALENDAR-005` | 409 JSON/status | The stored Calendar grant is revoked, broken, or missing its required scope | “Google Calendar needs to be reconnected.” |
| `SAMO-CALENDAR-006` | 502 JSON | Calendar synchronization failed and no usable cache is available | “Upcoming meetings couldn’t be refreshed. Please try again.” |
| `SAMO-CALENDAR-500` | 500 JSON or 302 query | Unexpected internal Calendar failure | “Something went wrong connecting Google Calendar.” |

**Why:** Upcoming meetings are useful before auto-join is enabled and provide a smaller, reviewable first slice of the §5.12 Calendar feature. Keeping consent incremental preserves the S5-1 security and verification boundary around ordinary sign-in; choosing the narrower event-only scope and minimizing the cache reduces retained personal data. Auto-join remains separate because it introduces independent scheduling, cost, eligibility, idempotency, and per-event-control requirements.

---

### S5-4. Typography — dual sans/mono stack — *Deviation (post-v1)*

**Amends:** `DESIGN.md` §Typography, which specifies JetBrains Mono as the only typeface.

**What differs:** App chrome and prose use Inter through `--font-sans`; body and display roles resolve to that stack. JetBrains Mono remains the `--font-mono` data face for transcripts, timestamps, identifiers, URLs, commands, and keyterms.

**Why:** A sans face makes dense app chrome and prose easier to scan while preserving mono where its data-oriented character and alignment are useful.

### S5-5. Layout — wider app, prose, and form columns — *Deviation (post-v1)*

**Amends:** The legacy blanket 32rem application column.

**What differs:** Application pages use `--width-app: 1120px`, prose uses `--width-prose: 720px`, and narrow forms use `--width-form: 480px`.

**Why:** Calls and transcripts need horizontal room, while prose and forms retain purpose-specific readable measures instead of sharing one restrictive width.

### S5-6. Interaction color — instrument-only live accent — *Deviation (post-v1)*

**Amends:** `DESIGN.md` §Color tokens and §Interaction and accessibility where `accent-live` had also supplied general focus and hover color.

**What differs:** `accent-live` is restricted to the transcript instrument. General focus and hover treatments are achromatic through `--focus-ring` and `--hover-surface`. These tokens land in Slice 1; adoption across controls follows in Slices 2–6.

**Why:** Reserving green for live state protects its meaning, while ink-based interaction states provide stronger contrast in both themes.

### S5-7. §5.2 / §5.10 / §5.12 — Calendar meetings and opt-in auto-join — *Extension*

**Amends:** §5.2 (call creation and bot join path), §5.10 (data model), and
§5.12 (Calendar settings). PRs **#242, #243, #244, #245, #246, #249**, **#264**, **#265**, **#269**, and
**#271**; follow-ups **#266** and **#270**.

**What differs:** The S5-3 incremental Google Calendar connection now backs a
meetings-only upcoming list with an explicit **“Add samograph”** action (#264),
and an owner-controlled `auto_join` switch plus durable per-event exclusions
(#271). The poller auto-joins eligible, non-declined, non-all-day events with a
validated Meet or Zoom URL from 10 minutes behind the current time through 6
minutes ahead (#269). Calendar creation uses the shared `createCallForTenant`
path (#265), so it retains normal URL validation, tenant settings, audit and
enqueue behavior, but has a separate 10/hour/tenant limiter. Its idempotency key
is connection-scoped (`<connection_id>:<provider_event_id>`).

For both manual and Calendar creation, an advisory transaction lock enforces one
active bot per tenant and normalized meeting URL. A conflicting `POST /calls`
returns HTTP 409 `SAMO-CALL-ACTIVE` with the existing call id; Calendar poller
conflicts are skipped. `calls.source` (`manual | calendar`) and
`calls.source_event_id` record provenance, with a unique non-null
tenant/source/event identity.

**Schema additions:** migration `0016_calls_source.sql` adds `calls.source` and
`calls.source_event_id`; `0017_calendar_autojoin.sql` adds
`calendar_connections.auto_join`; and
`0018_calendar_event_autojoin_exclusion.sql` adds the RLS-protected
`calendar_event_exclusions` table keyed by connection + provider event. These
extend S5-3's `calendar_connections` / `calendar_events` schema.

**Why:** This deliberately ships the §5.12 Calendar auto-join capability after
v1 while preserving incremental consent and routing every join through the same
cost, tenancy, validation, and lifecycle boundary as pasted-URL calls.

### S6-1. Landing page — radical simplification — *Deviation (post-v1)*

**Amends:** `SPEC.md` §5 landing description and the Refined landing composition in `DESIGN.md` / `design-ref/RefinedLight.dc.html` + `RefinedDark.dc.html`, which specify a hero with a simulated live "instrument" panel, a four-card differentiators grid, a four-step "From link to live page" list, a heritage/CLI section, and a closing band.

**What differs:** The landing is one screen: nav (brand, theme switcher, sign-in button), a single `h1` — "An agent that joins your call and transcribes it live." — one supporting line, one primary CTA to `/auth` plus a `github` secondary link, and a minimal footer. The simulated instrument, differentiators, step list (including the "Sign in" step), heritage/CLI section, and closing band are removed, along with their CSS. Rendered visible text above the footer drops from 428 words to 26. A skip link is added; the transcript-panel CSS primitives the per-call view composes are retained.

**Why:** Owner feedback on the shipped page: it was too complicated and too wordy, and a "Sign in" step is not information a developer needs. A developer should be able to tell what samograph is, and start, in about five seconds.

**Follow-up (2026-08-26).** The first pass of this simplification kept a compact four-line transcript glimpse (`[00:12:04] Dana: ...`) under the CTAs as a format sample. Owner feedback — *"i don't like the stupid example with dana, morgan, etc."* — and it was removed outright with nothing in its place, along with the `.samograph-glimpse` CSS. Invented speakers and invented utterances are a fake product demo, not evidence; the page now shows only claims it can stand behind. This is why the word count above reads 26 rather than the 55 the glimpse version shipped with.
