# samograph.dev v1 — Sprint 3 "harden + ship" — EXIT HANDOFF (STOP for human testing)

> **Sprint 3 is CODE-COMPLETE.** Per the process (root `CLAUDE.md`), we STOP here for human manual testing + the release steps only the owner can do. `main` (`5cd6b94`) is green — 1448 tests, 0 failures, `tsc` clean. Every change went finding/issue → strict red/green TDD → CI green → adversarial Security + Bug-Hunter review → squash-merge.
>
> This is the final v1 sprint. After the release gate below, v1 ships.

---

## 1. Release gate — the human-only steps to ship v1 (DO IN ORDER)

### ⚠️ STEP 1 — The coupled deploy cutover (security-review Blocker #2). Do all sub-steps together, or prod refuses to boot (that is the intended fail-safe).

The new secure app-api entrypoint `apps/app-api/server.ts` is fail-closed; the old dev entrypoint `dev-server.ts` refuses to boot unless `SAMO_ENV=dev`. So the cutover is atomic — on the VM (`ssh -p 2223 dev@…`):

1. In `/opt/samograph/envs/samograph-main/.env` set:
   - `SAMO_ENV=prod`
   - three **distinct** real secrets (32+ random bytes each; must NOT equal the committed `dev-only-*` defaults — boot fail-closes if they do): `SESSION_SECRET`, `MAGIC_LINK_SECRET`, `TOKEN_SECRET`. (ws-hub uses `SESSION_SECRET` + `TOKEN_SECRET`.)
2. Apply migrations (there is a NEW one, `0007_magic_links.sql`) **before restarting**: `bun packages/shared/db/migrate.ts` with the VM `DATABASE_URL`. The prod server uses the Postgres magic-link store, so the table must exist first.
3. ~~Repoint via `start-preview.sh`~~ **DONE** — `start-prod.sh` now launches `apps/app-api/server.ts` directly. samohost's `.samohost.toml` `execStart` fields declare the prod entrypoints for all preview envs; `start-preview.sh` is dead and should be removed from `/opt/samograph/` on next hostprep.
4. Restart both units. **Verify on the live host:** the session cookie carries `Secure`; `GET /__dev/last-magic-link` → 404; boot log shows no dev-default-secret warning.

**Why this is the #1 gate:** until the cutover, prod runs `dev-server.ts`, which strips the `Secure` flag off session cookies. (Your live prod already has real secrets set, so the more serious "forgeable session" fallback does not apply today — this closes the `Secure` gap and locks in the fail-safe boot checks.)

**Also note:** after this deploys, any session cookie older than 30 days starts returning 401 — the intended re-auth wave from the new server-side session TTL (#57).

### STEP 2 — Deliverability (SPEC §8). Needs DNS + a real inbox test.
- Confirm SPF / DKIM / DMARC are live for the sending domain (`samo.cat`).
- Send a real magic-link to a **Gmail inbox** AND at least one **corporate mailbox**; confirm it lands (not spam) and the link signs you in.
- The per-IP magic-link limit now derives the client IP from Cloudflare's `cf-connecting-ip` (#163) — confirm the edge sets it.

### STEP 3 — Staging §3 acceptance drill (SPEC §6.3). Manual, human-run, capture evidence.
Walk all v1 stories on staging:
- **Story 1** create call → live transcript streams; **Story 2** share link works + revokes ≤1s; **Story 3** transcript download; **Story 4** COULD_NOT_JOIN "Try again"; **Story 5** forced tunnel outage → warning banner + recovery; **Story 6** disclosure fires when recording, and a non-recording bot goes COULD_NOT_RECORD **without** a disclosure.
- Two cases test-covered but never drilled live: a **silent call** (no speech) still reaches IN_CALL; the **degraded banner** on a forced outage.
- Observe the **pickup-latency SLO** (event → status-visible p95 ≤ 1s) on the now-live `GET /metrics` and the activation-funnel dashboard (`docs/observability/activation-funnel.dashboard.json`).

### STEP 4 — Ship: deploy to prod with the primary region serving traffic. (Second region stays warm/deferred — §4.)

---

## 2. What shipped this sprint (all merged to `main`, green)

**Foundation / hardening:** #147 transcript-crash guard · #150 cross-tenant RLS UPDATE/DELETE + trigger tests · #152 hermetic deps (committed `bun.lock` + `@types/node`) · #149 trusted-proxy ops doc.

**Auth cluster:** #154 **real prod entrypoint + prod fail-closed secrets** (closes the cookie-`Secure` hole, dev-gated) · #157 **server-side session TTL** · #159 **deleted-tenant → 401 clear-cookie** · #158 **Postgres magic-link store** (atomic, restart/replica-safe) · #153 magic-link rate-limit ordering · #161 **per-tenant bot-create limit + per-call read WS cap + share-view allowlist**.

**Observability:** #151 `bot_join_total` producer · #160 **shared MetricsRegistry + `GET /metrics`** · #162 **DB-backed activation funnel** (the §9 v1 success metric).

**Frontend:** #155 past-calls section + `COULD_NOT_RECORD`/`BOT_REMOVED` copy + empty/loading states + final marketing copy · #148 magic-link 5xx-vs-invalid error copy.

**Multi-region (code only; deploy deferred):** #156 §4.7 region-selection policy + §4.5 tunnel-posture amendment.

**Security-review fixes:** #164 **botLifecycle S2-16 blocker** (a live call could be killed by a re-delivered event) · #166 malformed-timestamp retry-loop guard · #163 per-IP rate-limit XFF-spoof fix · #165 bot-create cap concurrency fix · #167 REST transcript per-token caps.

**Closed as verified-resolved:** #117 (RECALL_LIVE disclosure), #118 (status poller), #120 (real-Recall Svix parser).

---

## 3. Final security review outcome

Adversarial review across 5 surfaces + a re-audit of the token verifier:
- **Tenancy gate + RLS: sound** — fails closed, no cross-tenant read/write/delete bypass found.
- **Capability-token verifier: sound** — constant-time compare, `jti` UNIQUE (replay-safe), `read` scope never persisted, revoke effective on next verify, no alg/KID confusion.
- **Webhook auth front door: sound** — constant-time `?t=` check, fail-closed, idempotent dedup with dispatch inside the tx.
- **1 confirmed CODE blocker → FIXED (#164):** `botLifecycle.ts` was regressing a live IN_CALL call to a terminal status on a re-delivered `in_call_not_recording`/`fatal` event (violated amendment S2-16 — the previous handoff had *wrongly* marked this fixed). Now guarded per-transition and regression-tested.
- **4 hardening fixes applied** (#166, #163, #165, #167) — see §2.
- **1 release-gate blocker = the deploy cutover** (Step 1) — not a code defect.

---

## 4. Deferred — NOT launch gates (post-launch / fast-follow)

- **Second region + §4.7 staging exercise:** the CODE shipped (#156; policy defaults to the single healthy `us-east`). Standing up region 2 behind the tunnel is infra — explicitly not a launch gate (§4.7).
- **Isolated benchmark runner (#109):** provision a single-tenant runner labelled `samograph-bench-isolated` + set the repo var so the p99 ≤ 5ms WS SLO asserts (today it skips-loud on shared CI).
- **Tenant-isolation defense-in-depth (latent):** confirm the prod app `DATABASE_URL` role is a non-superuser/non-owner so a *future* forgotten `SET LOCAL ROLE samograph_app` fails CLOSED. All current paths switch correctly; this guards against a future mistake. Consider a distinct privileged role for the enumerated pre-tenant lookups.
- **Minor defense-in-depth:** token `iat`/`exp` finite-integer + scope `string[]` type guards; webhook dual-channel dedup-key normalization (only relevant if both a signed account webhook AND the unsigned realtime endpoint are ever configured for the same event).
- **v2 (deliberately not built):** the AI-agent channel + `act:*` scope enforcement (#66). Seams are pre-wired.

---

## 5. Notes

- **Suspicious patch on issue #145:** an external account (`govabunubu`) attached `samograph_patch.zip` claiming to rewrite the webhook auth. It was **NOT** applied — it has the markers of a supply-chain attempt on the most security-critical component. Recommend hiding/deleting the comment.
- **The samorev CLI (`bun run samorev review`) does not exist in this repo** — the merge gate's "real code analysis" was run via the adversarial Security + Bug-Hunter reviewer agents (the equivalent path `CLAUDE.md` allows), posted as PR comments. If the deterministic CLI is wanted, it needs installing.
