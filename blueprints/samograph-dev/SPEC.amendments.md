# samograph.dev — SPEC Amendments (Sprint 1)

This document records every **intentional** deviation from or extension to
`blueprints/samograph-dev/SPEC.md` made during Sprint 1 ("the seams"). Each entry
cites the section it amends, states precisely what differs from a literal reading
of the spec, and explains why. These are reviewed decisions — not silent drift.

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