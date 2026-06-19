# samograph.dev — SPEC v0.2

## 1. Goal & why it's needed

**Goal.** A zero-setup, hosted SaaS that puts a Recall.ai meeting bot in your calls and streams a perfect, shareable, persisted **live** transcript to a page you (and anyone you share the link with) can read along with as the call happens — then keeps that transcript forever in your account.

**Why this exists.**

- The existing CLI `samograph` already gives engineers a meeting bot, but it requires running Bun, managing a `RECALL_API_KEY`, and operating an ngrok/cloudflared tunnel. That puts it out of reach for ~every non-CLI user, and out of the daily workflow even of most engineers.
- Current paid tools (Otter, Fireflies, Read, tl;dv) bury the *live* transcript: they show it post-call or behind sluggish polling, and **none offers a public shareable live read-along link**.
- Live read-along is the killer use case the team hits every week: stand-ups with strong-accent speakers, multilingual customer calls, calls with hard-to-hear audio. Reading word-by-word as the call happens makes those calls usable.
- Recall.ai keeps **video for only ~7 days** on the free developer plan. Transcripts must therefore be persisted to our DB in real time or they vanish — and a transcript-first product is exactly what we want anyway.

**Why now.** Recall.ai's WebSocket transcript stream is mature (we already proved it in the CLI), magic-link auth + Google OAuth are commodity, and Bun + Postgres on a single VPS comfortably handles dozens of concurrent calls in v1.

**Anti-framing (honor strictly).** This is **NOT a desktop CLI** distribution — users never touch the CLI, never see a token, never run a tunnel. This is **NOT a Zoom/Meet plugin** — the bot joins via the standard meeting link as any participant would. This is **NOT an AI-summary product in v1** — the v1 thesis is that *just streaming and persisting a great live transcript* already beats every current paid tool. If a future change tries to re-introduce "CLI for end users" or "v1 AI summaries," reject it.

## 2. Personas

**The hire authoring this spec:** Veteran real-time meeting SaaS product engineer. Has shipped Otter-like products and knows the Recall.ai stack, WebSocket fan-out at meeting scale, and the OAuth + calendar minefield.

**Intended end-user personas the product serves:**

- **Priya — Distributed PM** *(primary v1 persona)*: runs daily customer calls with strong accents; needs a live read-along link to share with her team mid-call and a perfect post-call transcript for follow-ups. Locked-down laptop — cannot install CLIs.
- **Marco — Engineering manager**: forwards Calendar invites to the bot for any call he can't attend; reads the live transcript from the next room and pastes a few lines into Slack.
- **Sasha — Non-native-English speaker on a fast-talking team**: opens the live page on a second monitor and *reads* the meeting in real time to keep up.

## 3. v1 Scope (this week — the primary build target)

### 3.1 Decisions for the previously-open interview questions

| Question | v1 answer |
|---|---|
| **Primary user** | Distributed PMs and EMs who attend many spoken-English calls with at least one hard-to-understand voice (accent, audio quality, jargon). Priya is the avatar. |
| **Single job-to-be-done** | "I clicked one button last week; today the bot is in my call and I (and anyone I share the link with) can read along live and re-read later — with zero setup." |
| **Meeting platforms day one** | **Google Meet and Zoom**, both via Recall.ai (already proven by the CLI). MS Teams deferred to v2. |
| **Auth** | **Email magic-link + Google OAuth.** The Google sign-in is also what unlocks Calendar — one consent, two jobs. |
| **Single success metric** | **W2 live-transcript-open ratio** = (# distinct opens of `/c/<token>` for meetings the user owns in week 2 after signup) ÷ (# meetings auto-joined for that user in the same week). Target ≥ 0.6 across the W2 cohort. This measures whether the read-along — our differentiator — is actually used, not vanity signups. |
| **Out of scope for v1** | (a) any LLM/AI features (no summaries, action items, semantic search, sentiment); (b) long-term **video** storage (we keep Recall's free 7-day window); (c) post-call email; (d) multi-language UI; (e) custom/branded bot identities; (f) paid billing and seats (single free tier with rate limits); (g) transcript editing; (h) MS Teams; (i) native mobile apps (mobile *web* only). |

### 3.2 User stories (each: persona + action + outcome + manual-test recipe)

**U1 — Sign in with Google in under 30 seconds.**
- *Persona:* Priya (first-time visitor).
- *Action:* Lands on `samograph.dev`, clicks "Sign in with Google," grants the minimum scopes shown on the consent screen.
- *Outcome:* She is on her dashboard with an empty "Upcoming meetings" list and a green "Calendar connected" badge.
- *Manual test:* Open an incognito window, complete the OAuth flow, confirm landing on `/app` with the badge visible and rows present in `users` and `oauth_accounts`.

**U2 — Connect Calendar; bot auto-joins the next meeting.**
- *Persona:* Priya.
- *Action:* Within 5 minutes of signing in, her Calendar shows a new event with a Meet/Zoom link; she does nothing.
- *Outcome:* At T-1 minute the bot is in the lobby/call as `samograph (Priya) — recording transcript`; at T+0 the per-call page is live with a streaming transcript.
- *Manual test:* Create a Calendar event 3 minutes out with a real Meet link, watch `/calls/:id` populate with words within 30 s of the bot being admitted; confirm one `bots` row, one `calls` row, and a stream of `transcript_lines` writes.

**U3 — Read along live and share the link.**
- *Persona:* Sasha (a teammate of Priya, no account).
- *Action:* Priya pastes `https://samograph.dev/c/<shareable-token>` into Slack; Sasha opens it on a second monitor.
- *Outcome:* Words appear chunk-by-chunk over WebSocket (no reload, no polling). A "live • N viewers" badge updates. The page exposes only meeting title + transcript + viewer count — no private user data.
- *Manual test:* Open the share link in a private window on another device, verify words stream in ≤2 s after they are spoken; confirm the response carries no user PII.

**U4 — Custom dictionary improves recognition for the next call.**
- *Persona:* Marco.
- *Action:* Before a Postgres deep-dive call, in `/settings/dictionary` he pastes terms: `pg_stat_statements, EXPLAIN ANALYZE, samograph, DBLab`.
- *Outcome:* In the very next call, those words land correctly in the transcript instead of phonetic guesses.
- *Manual test:* Hold one call without the term, add it, repeat the same spoken phrase in a second call — confirm transcripts diverge in the expected direction. (Recall.ai's keyterm hints are passed through unchanged.)

**U5 — Post-call: the transcript is durable, exportable, attributed.**
- *Persona:* Priya, the next day.
- *Action:* Opens the call from her dashboard.
- *Outcome:* Full transcript with per-speaker labels and timestamps; one-click export to `.txt` and `.md`. Recall.ai video may already be expired; the transcript is not.
- *Manual test:* Wait 24 h after a recorded call (or, in dev, mark Recall video expired); confirm the transcript still loads from our DB and exports correctly.

**U6 — Consent and recording disclosure are visible to all participants.**
- *Persona:* Any meeting participant who is not Priya.
- *Action:* Sees the bot join.
- *Outcome:* Bot display name is `samograph (Priya) — recording transcript`. When the bot enters, it auto-posts in meeting chat: *"Hi — I'm samograph, transcribing this meeting on Priya's behalf. Live transcript: samograph.dev/c/<token>. Ask Priya to remove me if you'd prefer not to be transcribed."* The host can `/leave` from their dashboard one-click.
- *Manual test:* Join a Meet/Zoom call as a third party; confirm the chat message appears within 10 s of the bot's join, the display-name is correct, and a Leave click removes the bot in ≤10 s.

**U7 — Per-meeting opt-out so private 1:1s stay private.**
- *Persona:* Priya.
- *Action:* On her dashboard, she flips a toggle on tomorrow's "1:1 with my therapist" event. Also supported: putting `[private]` or `[notranscribe]` in the event title or description.
- *Outcome:* The bot does not join that meeting; the dashboard shows the event greyed out with reason.
- *Manual test:* Create a Calendar event titled `[private] 1:1`; confirm the worker logs `skip:per-event-opt-out` and no bot joins.

**U8 — The SaaS promise: tunnel-free, key-free, install-free.**
- *Persona:* Priya.
- *Action:* Nothing — she does not install Bun, does not see a Recall token, does not configure ngrok.
- *Outcome:* All Recall plumbing runs server-side on our infra; the user surface is a web app.
- *Manual test:* Inspect Priya's browser network tab during a call — no third-party tokens, no localhost calls, no install prompts.

### 3.3 Explicit non-goals in v1 (do not silently expand)

- No LLM summarization, action-item extraction, semantic search, sentiment, or any "AI" feature.
- No long-term **video** storage (transcripts only; we accept Recall's 7-day video window).
- No MS Teams.
- No paid plans, billing, seats, teams. Single free tier with rate limits (§5.4).
- No bot identity customization. Display name is `samograph (<owner first name>) — recording transcript`.
- No post-call email — the dashboard is the durable surface.
- No native mobile app (responsive web is enough).

## 4. v2 Scope (later — explicitly deferred)

Listed here so v1 architecture leaves the right seams open.

- **Synced transcript+video viewer.** Click a word → video seeks. Needs persistent video.
- **Cheap long-term video storage.** Egress from Recall → S3-compatible cold storage (Backblaze B2 or Cloudflare R2 at ~$6/TB/mo vs. S3 $23/TB/mo).
- **Consistent bot identities.** Per-workspace named bots ("Maya from Acme").
- **Post-call email of transcript** to all detected participants, with one-click unsubscribe.
- **Multi-language UI** (i18n keys laid out in v1 even though only `en` ships).
- **MS Teams** (Recall supports it).
- **Team workspaces** with shared meeting libraries and per-seat billing.
- **Live AI assist (opt-in).** First AI feature, gated behind a workspace setting.
- **Pre-admit consent flow** (hold the bot in the lobby until a host clicks "admit + consent recorded").

## 5. Architecture

<!-- architecture:begin -->

```text
(architecture not yet specified)
```

<!-- architecture:end -->

### 5.1 Components

```
                         Browser (Next.js app)
                          |             ^
   sign-in / dashboard    |             | WS: transcript chunks
                          v             |
                   +-------------------------+
                   |  API/Edge (Hono on Bun) |
                   |  - auth, OAuth, calendars
                   |  - /c/<token> live page
                   |  - WS fan-out hub
                   +-------------------------+
                       |        |        ^
            +----------+        |        | (transcript writes)
            v                   v        |
     Postgres (Neon)     Calendar Poller |
     - users             - 1 min cron    |
     - oauth_accounts    - next 15 min   |
     - calendars                         |
     - calendar_events    -> enqueue join
     - bots                              |
     - calls                             |
     - transcript_lines  ---------------- + (append-only)
     - dictionaries                       |
     - share_tokens                       |
                                          |
                               +---------------------+
                               |   Bot Worker (Bun)  |
                               |  - spawns Recall bot|
                               |  - shared cloudflared
                               |    tunnel (per region)
                               |  - webhook ingest   |
                               +---------------------+
                                          |
                                          v
                                   Recall.ai (Meet/Zoom)
```

- **Frontend:** Next.js (App Router) on Vercel or Cloudflare Pages. The live page is static HTML + a WebSocket — no SSR cost on the hot path.
- **API/Edge:** Hono on Bun (matches the repo's Bun-first stance). Hosts REST + the WS hub.
- **DB:** Postgres on Neon (cheap, branchable, RLS-capable). System of record for everything — including transcripts.
- **Calendar poller:** Bun cron, every 60 s per user; fetches the next 15 minutes of events and enqueues `join` jobs at T-60 s. Google push notifications are added on top of polling for sub-minute latency.
- **Bot worker:** A pool of long-running Bun processes. The **single shared Recall API key** lives only here, in a secret manager. The worker is essentially the existing `samograph join` flow refactored to (a) use a *managed, multi-tenant* tunnel (one persistent cloudflared per region rather than one ngrok per call), and (b) write transcript chunks to Postgres + publish to the WS hub.
- **Tunnel:** One cloudflared *named* tunnel per worker region, persistent. Recall webhooks carry the `bot_id`; the worker routes events to the right call by it. This is the critical departure from the CLI (one ngrok per user); N ngroks per N users would not work.
- **Object storage (v2 only):** R2 or B2 for video egressed from Recall.

### 5.2 Boundaries & key abstractions

- `User`, `Workspace` (one-user-one-workspace in v1; schema designed for many-to-many in v2).
- `Calendar`, `CalendarEvent` (mirrored from Google).
- `Call` (one per meeting the bot attends). Owns `bot_id` from Recall, `share_token`, `started_at`, `ended_at`, `state` (see §6.2).
- `TranscriptLine` (append-only: `call_id`, `speaker`, `text`, `started_at`, `is_final`, `version`). Interim words rewrite the trailing line by bumping `version`; WS sends `{type:"line"}` for finals and `{type:"partial"}` for interims.
- `Dictionary` (per user; passed as Recall keyterm hints when creating the bot).
- `ShareToken` (random 22-char URL-safe slug ≈ 131 bits, no PII, revocable/rotatable).

### 5.3 Tenant isolation (the open-question risk turned into a decision)

Shared Recall token but per-user bots. The risk is that a bug or compromised `bot_id` lets user A read user B's transcript. Mitigations, all of which must ship in v1:

- Every webhook arriving at our worker is correlated `bot_id → call_id → user_id`; transcript writes go through a `WHERE user_id = ?` constraint enforced by **Postgres Row-Level Security** policies on `calls` and `transcript_lines`.
- `bot_id` is never exposed to the browser. The `/c/<token>` page authenticates by share token only.
- The Recall token is read only inside the bot worker process; it is never present in the API/Edge or the DB.
- Inbound webhooks are validated: we sign join requests with a per-bot nonce, and any webhook for an unknown or expired `bot_id` is dropped before any DB write.

### 5.4 Rate limits and cost guardrails (v1)

To keep the free tier from blowing up the Recall bill:

- Per user: max 4 concurrent calls, 6 hours/day, 30 hours/month. Above the cap, calendar events are silently skipped with a dashboard banner explaining why.
- Per call: max 100 concurrent share-link viewers on the WS hub.
- Global `kill_switch` env flag pauses all new joins (incident response).

## 6. Implementation details

### 6.1 Data flow — live transcript end-to-end

1. Recall POSTs `transcript.data` webhooks to `https://<region>.tunnel.samograph.dev/webhook` (the long-lived shared tunnel) with the JSON body and a `bot_id`.
2. Worker calls `formatTranscriptLine()` (reused unchanged from the CLI repo) → `{speaker, text, t0, t1, is_final}`.
3. Worker INSERTs (or UPDATEs the same `version`) into `transcript_lines`, then publishes onto an in-process pub/sub channel keyed by `call_id`.
4. WS hub: each `/c/<token>` connection subscribes to that channel. On subscribe, the hub sends the last 200 finalized lines as backfill, then live messages.
5. Browser appends finals; replaces the trailing partial.

Reusing `formatTranscriptLine` keeps a single source of truth between CLI and SaaS so Recall payload-shape changes can't drift.

### 6.2 State transitions for a `Call`

```
calendar_event_detected
   -> scheduled        (join job enqueued at T-60s)
      -> joining       (Recall createBot called, bot_id known)
         -> in_call    (first transcript.data received)
            -> finished (Recall call_ended event OR user clicks Leave)
               -> archived (post-call: clear partials, finalize export caches)
   -> skipped (per-event opt-out, rate limit, duplicate)
   -> failed  (Recall error, tunnel unreachable, lobby denied)
```

`failed` is terminal with a typed reason surfaced on the dashboard (e.g. "Couldn't join — host denied entry").

### 6.3 Key algorithms

- **WS backpressure.** Each viewer has a 1 MB outbound buffer; on overflow we drop *partials* (never finals) and send `{type:"resync", from: last_seq}` so the client refetches via REST.
- **Calendar poll dedupe.** Events are keyed by `iCalUID`; a re-scheduled event updates the row in place instead of spawning two joins.
- **Share-token entropy.** 22 chars base62 ≈ 131 bits, unguessable. Rotatable via `POST /api/calls/:id/rotate-token`; old token returns HTTP 410.
- **Bot display name.** `samograph (<owner_first_name>) — recording transcript`. Capped at the Recall name length limit; Unicode-normalized to avoid surprise renderings inside Meet/Zoom.
- **Tunnel-health watchdog (multi-call).** Periodic `probeTunnelHealth` (ported from the CLI). On 2 consecutive failures the worker fans out a `SAMOGRAPH-WARNING: tunnel unreachable` event into **every** active call's WS so all viewers see it, and into every persisted transcript so the durable record reflects the gap.

### 6.4 Consent / recording disclosure

We will run in two-party-consent jurisdictions (CA, much of EU). v1 minimum:

- Bot display name contains "recording transcript".
- Bot auto-posts the U6 disclosure message in meeting chat on join — this is the explicit disclosure act.
- TOS makes the calendar-connecting user responsible for getting attendee consent.
- v2: add the pre-admit consent gate.

## 7. Tests plan

CI runs `bun test` and `bunx tsc --noEmit` on every PR; samorev review gate (per `CLAUDE.md`) is required before any merge.

### 7.1 Pyramid

- **Unit** — everything in `packages/shared/` and `lib/`: transcript-line normalizer, share-token generator, opt-out matcher, rate-limiter, WS fan-out backpressure, Calendar event diff.
- **Integration** — API endpoints against a real Postgres (testcontainers). Calendar poller against a Google Calendar mock (recorded fixtures). Webhook ingest against synthetic Recall payloads (lifted from the existing CLI tests).
- **End-to-end** — Playwright scripts for sign-in, dashboard, live page open + WS messages. A nightly real-bot E2E against a dedicated test Meet link using a Recall sandbox bot.

### 7.2 Built test-first (TDD red → green — mandatory)

These are the pieces most likely to be subtly wrong; each one must be written test-first:

1. `formatTranscriptLine` adapter for the worker (partial/final emission semantics).
2. Share-token generator + validator (entropy, revocation, 410 on revoked).
3. WS hub (backpressure, backfill of last 200 lines, drop-partials-never-finals policy).
4. Rate limiter (per-user concurrent / daily / monthly).
5. Calendar opt-out matcher (title/description keywords + per-event toggle).
6. **Webhook → call_id → user_id authorization gate** (every transcript write must go through it — this is the tenant-isolation hinge from §5.3).
7. Multi-call tunnel-health watchdog (the worker's tunnel down = every active call degraded; the test must assert warnings fan out to *every* call's WS, not just one).

### 7.3 Not TDD'd (built behavior-first, covered after)

UI components, OAuth flow plumbing, dashboard styling, marketing landing page — snapshot + Playwright after the fact.

## 8. Team (veteran experts to hire)

Sprint capacity for v1: **4 engineers + 1 designer for 2 weeks**.

- **Veteran real-time meeting SaaS product engineer (1).** Lead. Owns architecture, Recall.ai integration, tenant isolation, multi-call tunnel.
- **Veteran full-stack Bun/TypeScript engineer (1).** Owns API/edge, WS hub, calendar poller. Hono + Postgres comfortable.
- **Veteran frontend engineer — Next.js / live-data UIs (1).** Owns dashboard and the live read-along page (the differentiating UX).
- **Veteran SRE with tunnel & webhook expertise (1).** Owns the shared cloudflared infra, observability, on-call runbook. Has been paged at 3 AM for ngrok before.
- **Veteran product designer — UX for live-data displays (1).** Owns reading rhythm, share-link affordances, consent disclosure copy.

v2 adds: 1 ML/AI engineer, 1 backend engineer for storage + billing.

## 9. Implementation plan (sprints, with parallelization)

**Two one-week sprints to v1 public beta.** Track names map to roles in §8: Lead, Backend, Frontend, SRE, Design.

### Sprint 1 — "bot in the call, transcript on the page" (week 1)

Parallel tracks; order within a track matters.

- **Lead (critical path):**
  1. Monorepo (Bun workspaces): `apps/web`, `apps/worker`, `packages/shared`.
  2. Port `formatTranscriptLine`, `probeTunnelHealth`, tunnel watchdog into `packages/shared`.
  3. Stand up shared cloudflared tunnel + `bot-worker` skeleton that can `createBot` against a real Meet link.
- **Backend:**
  1. Migrations: `users`, `oauth_accounts`, `calls`, `transcript_lines`, `share_tokens`, `dictionaries`. RLS policies on `calls` + `transcript_lines`.
  2. Magic-link auth (Resend or Postmark).
  3. Google OAuth — minimum scopes `openid email profile` + `calendar.events.readonly`.
  4. WS hub + pub/sub on `call_id`.
  5. REST: `POST /api/calls/:id/leave`, `POST /api/calls/:id/rotate-token`, `GET /api/me`.
- **Frontend:**
  1. `/login` (magic-link + Google).
  2. `/app` dashboard (upcoming events, past calls, dictionary, leave button).
  3. `/c/<token>` live page (WS connection, append-final, replace-partial, viewer-count badge, consent banner).
- **SRE:**
  1. Worker VPS + cloudflared named tunnel per region (`us`, `eu`).
  2. Postgres on Neon (prod + ephemeral branch per PR).
  3. Logging (Axiom or self-hosted Vector), uptime checks against `/health`.
  4. Budget alerts on Recall.ai usage.
- **Design:**
  1. Live read-along visual rhythm (word-by-word reveal, speaker-color rotation, ARIA-live).
  2. Consent disclosure copy + in-chat message template.
  3. Empty/error states for the dashboard.

**Sync points:**
- Day 2 EOD — Lead + Backend: auth flow reaches the worker session.
- Day 4 EOD — Lead + Frontend: live WS messages render on `/c/<token>` end-to-end.
- Day 5 EOD — Sprint 1 demo: a manually-scheduled real call shows up on the live page.

### Sprint 2 — "auto-join + share + ship" (week 2)

- **Lead:**
  1. Calendar poller (1-minute cron) → enqueues join jobs.
  2. Rate limiter wired into the poller.
  3. Multi-call tunnel-health watchdog: warnings fan out to *every* active call's WS.
- **Backend:**
  1. Google Calendar push notifications as a fallback to polling for sub-minute latency.
  2. Opt-out: per-event toggle + `[private]`/`[notranscribe]` keyword matcher.
  3. Custom dictionary endpoint + Recall keyterm passthrough.
  4. Export endpoints: `.txt` and `.md`.
- **Frontend:**
  1. Calendar opt-out toggles on the dashboard.
  2. Dictionary editor.
  3. Share-link UI (copy, rotate, revoke).
  4. Mobile-web layout for `/c/<token>`.
- **SRE:**
  1. Per-call observability dashboard (lines/min, viewers, tunnel health).
  2. Postgres backup + restore drill.
  3. Public status page.
- **Design:**
  1. Final polish on live page (reading rhythm, accessibility).
  2. 3-step onboarding tour.
  3. Marketing landing page positioning around live read-along + persistence (not AI).

**Sync points:**
- Day 8 — end-to-end dogfood: team uses it for stand-up; bugs filed.
- Day 9 — opt-out + share-link UX freeze.
- Day 10 — ship public beta on `samograph.dev` (or `app.samograph.dev`).

## 10. Open questions & risks

| # | Question / risk | Why it matters | Plan |
|---|---|---|---|
| Q1 | Recall.ai per-minute cost at projected v1 volume | Could blow budget at scale. | Lead pricing call week 1; hard-cap free tier (§5.4) until known. |
| Q2 | Shared Recall token tenant isolation | A bug could leak A's transcript to B. | RLS at DB + bot_id-scoped writes (§5.3); third-party pen-test before public launch. |
| Q3 | Minimum viable Google OAuth scopes | Larger scopes block users (brand-verification queues). | `calendar.events.readonly` only; defer write scopes to v2. |
| Q4 | Shareable-link security | A leaked link exposes the whole call's transcript. | 131-bit token, revoke button, per-call rotation; v2: optional passphrase / SSO gate. |
| Q5 | Consent/recording disclosure across jurisdictions | EU/CA two-party consent. | Bot name says "recording", in-chat disclosure (U6); TOS shifts duty to host. v2: pre-admit consent flow. |
| Q6 | Tunnel as SPOF | Regional cloudflared down = ALL active calls lose webhooks. | Two cloudflared replicas per region (active/active under one name); watchdog warns into every live transcript. |
| Q7 | Transcript storage cost trajectory | 1 hr Meet ≈ 8k words ≈ 50 KB plain text — cheap, but check growth. | Plain `text` column in Postgres v1; move to compressed cold storage at >100 GB. |
| Q8 | Video persistence beyond Recall's 7 days | Deferred to v2; v1 thesis is transcript-only. | Covered by v2 spec (R2 + synced viewer). |
| Q9 | One Recall account for all bots vs. per-user | Per-user costs more, risks account limits. | v1: one Recall *bot per call* under one shared account; name carries identity. v2: per-workspace named bots. |
| Q10 | Recall.ai pricing/API change mid-build | Architectural risk. | Bot worker is the only consumer of Recall — keep that adapter swappable. |
| Q11 | Magic-link UX on corporate mail systems | Some strip one-time links. | Promote Google sign-in as default; magic-link as fallback. |
| Q12 | Live page WS scaling | 100 viewers × 100 calls = 10k connections/region. | Bun WS handles this on one node; sticky-by-`call_id` once we exceed 1 worker. |

## 11. Embedded Changelog

- **v0.2 (2026-06-19)** — First authored draft (replaces v0.1 scaffold). All five interview questions decided: primary user = distributed PMs/EMs on calls with hard-to-understand voices; core JTBD = live read-along + durable transcript with zero setup; platforms = Meet + Zoom day one (Teams in v2); auth = magic-link + Google OAuth; success metric = W2 live-transcript-open ratio ≥ 0.6; explicit v1 out-of-scope = AI, video persistence, post-call email, multi-language UI, branded bots, billing, MS Teams, native mobile. Added architecture diagram, 8 user stories with manual-test recipes, TDD list, 5-person team, 2-sprint plan, 12 open questions/risks. Anti-framing made explicit and binding: NOT a CLI for end users, NOT a plugin, NOT an AI product in v1.
- **v0.1** — Initial scaffold. Persona, idea, 5 interview questions stubbed ("decide for me").
