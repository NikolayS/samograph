# samograph Agent Notes

> NOTE (not part of the synced block): principle 2 (bugfix red/green TDD) originates here and should be upstreamed to the canonical PRINCIPLES.md.

<!-- SAMO-DEV-PRINCIPLES:START (synced block — update the canonical source then re-sync; do not edit in place) -->
## Development principles

Accumulated, non-negotiable working principles for SAMO projects. Canonical source: Tanya301/SAMO-Platform-Onboarding > PRINCIPLES.md. Keep this block in sync.

### 1. Re-review after ANY post-review change — green CI is not "reviewed"
Once a reviewer (samorev) approves an MR/PR, **any** later commit invalidates that approval — **including a commit that fixes the review's own findings**. Re-review the change (at minimum the new delta) **before** merge. Never merge a post-review commit on the strength of the prior PASS plus a green pipeline: a passing pipeline proves it builds and tests pass, not that it was reviewed.

Order: review → fix-commit → **re-review the delta** → merge.  (NOT: review → fix-commit → merge.)

### 2. Bugfixes are red/green TDD — no exceptions
Every bugfix PR MUST **first** add a test that reproduces the bug and **fails** on current `main` (RED), then the fix that turns it green (GREEN), then any refactor. The test comes first so we know it actually pins the bug: a test written after the fix proves nothing except that the code still does what it now does.

The PR description **pastes both** — the RED failure (the assertion/output on unfixed code) and the GREEN pass on the same test. **A bugfix PR without a reproducing test is rejected at review**, however small the diff.

"Confirmed in prod", "verified in the logs", or a manual repro is **not** a substitute for a test: it fixes today's incident and leaves nothing behind to stop the regression. If a bug genuinely cannot be expressed as an automated test, say so explicitly in the PR and get that exception agreed by the reviewer *before* merge.

Order: red test → fix → **paste RED + GREEN** → review → merge.
<!-- SAMO-DEV-PRINCIPLES:END -->

Use samograph to join a meeting, watch the live transcript, speak in meeting chat when asked, and capture the call view on demand.

## Preferred Flow

```bash
samograph join "https://meet.google.com/..." --name Leo --dict postgresfm
samograph watch
samograph presence listening
samograph notes init --doc-id 1abc... --credentials ~/.samograph/google.json --title "Meeting live doc"
samograph frames
samograph frame
samograph leave
```

Start `watch` immediately after `join` with your persistent monitor. Keep it running until the call ends. Each line is:

```text
[timestamp] Speaker: utterance
```

React in your agent session. Use meeting chat only for deliberate call-visible messages:

```bash
samograph chat "Short message to the meeting"
```

## Tunnel Health Warnings

`join` refuses to start when the webhook tunnel does not relay requests (e.g. ngrok `ERR_NGROK_727`, the account request limit) — better than joining a call it cannot hear. Mid-call, a watchdog re-checks the tunnel every minute and writes warnings into the transcript stream you are watching:

```text
[timestamp] SAMOGRAPH-WARNING: tunnel unreachable (ERR_NGROK_727) - transcript may be incomplete; rejoin with --tunnel cloudflared or --webhook-base
```

If a `SAMOGRAPH-WARNING: tunnel unreachable` line appears in the transcript, tell the user immediately: live transcript delivery is broken and lines are being lost. Suggest leaving and rejoining with `--tunnel cloudflared` (free cloudflared quick tunnel, no request limits) or `--webhook-base` with their own tunnel. A later `SAMOGRAPH-WARNING: tunnel recovered` line means delivery resumed, but anything said during the outage is missing from the transcript.

## Dynamic Bot Presence

The bot camera shows a live presence page. Update it from the agent loop to signal what you are doing. Five states: `listening|thinking|speaking|acting|idle`.

```bash
samograph presence listening
samograph presence thinking "Checking logs"
samograph presence speaking "Answering in chat"
samograph presence acting "Opening PR review"
samograph presence idle
```

Presence is in-memory runtime state for lightweight in-call signaling, not persistent memory. Transcript lines appear on the camera page automatically as "heard" activity without changing the state you set. Bare state toggles (no message) switch the state with its default message and do not add a Comments entry; only explicit messages appear in the Comments lane.

## Live Google Doc Notes

Use `notes` when asked to keep a shared doc updated during the call:

```bash
samograph notes init --doc-id 1abc... --credentials ~/.samograph/google.json --title "Customer call"
samograph notes point "Customer is blocked on cutover risk" --speaker Alice
samograph notes decision "Run a shadow replay before scheduling cutover"
samograph notes action "Create replay checklist issue" --owner Nik --due 2026-06-07
```

The doc must already be shared with the service-account email as an editor. Do not dump the whole transcript into the doc unless asked; use `notes transcript --from-start` only for raw transcript mirroring. Prefer concise GitLab-style notes: agenda/question context, important points, decisions, action items, owners, dates, and links.

## Looking At The Call

Frame capture is on by default. Recall sends `video_separate_png.data` frames over the ngrok HTTPS/WSS tunnel. Frames stay in server memory, indexed by source; disk writes happen only when the agent calls:

```bash
samograph frames
samograph frame
```

Default output is outside the repo:

```text
~/.samograph/frames/latest.png
~/.samograph/frames/latest.json
```

Use explicit outputs only when needed:

```bash
samograph frame --source screen --out /tmp/screen.png
samograph frame --source participant:100
samograph frame --out /tmp/call.png
samograph frame --archive
```

`samograph frames` lists source keys such as `type:screen_share` and `participant:100`. `frame --source` accepts those keys, plus aliases like `screen`, `screen_share`, and `webcam`.

`--archive` creates a timestamped filename with bot id, source type, and participant id.

## Mixed Video

Use RTMP only when separate PNG frames are not enough:

```bash
samograph join "https://zoom.us/j/..." --rtmp
samograph join "https://zoom.us/j/..." --rtmp-url rtmp://HOST:1935/live/call
```

`--rtmp` needs ngrok TCP, which requires ngrok card verification. `--rtmp-url` needs a public RTMP receiver.

## End The Call

```bash
samograph leave
```

`leave` removes the bot, stops local helper processes, writes the `SAMOCALL_CALL_ENDED` sentinel, and lets `watch` exit cleanly.

## Deploying

samograph deploys automatically. **You never SSH into the VM.**

1. Push your change to `main` on `NikolayS/samograph`.
2. Wait for GitHub Actions CI to go **green** on that commit.
3. The samohost control plane polls on a **5-minute** timer and, once CI is green on your commit, deploys it to the VM for you.

> ⚠️ **Changing with the deploy-topology cutover:** once `.samohost.toml` is registered, a merge to `main` deploys the **main preview**, not prod — production ships only on a dated `vYYYYMMDD.N` release tag. See "Deployment topology & CI/CD" below and `docs/runbooks/deploy-release.md`.

**Do not** add SSH keys to, or SSH into, the samograph VM to deploy. The control plane uses its *own* SSH into the VM as internal plumbing — that already exists and works, and is not a developer/agent step.

Notes:
- A commit whose CI is red / pending / missing is **skipped** (never deployed) — a deploy requires CI green on the pushed commit.
- To confirm a deploy landed: prod (https://samograph.samo.team) serves your new commit and returns 200. Deploy state is tracked in samohost.

## Merge Gate (samorev)

Every pull request must pass our review gate before it is merged. The gate is
[Tanya301/samorev](https://github.com/Tanya301/samorev) — a CLI-first code-review
tool. The default path below applies unless the owner explicitly authorizes the
[GPT substitution](#gpt-review-substitution-under-owner-instruction).
**Do not merge a PR unless all of the following are satisfied:**

1. **CI is green** — all CI/test checks pass (locally: `bun test` and
   `bunx tsc --noEmit` clean).
2. **samorev review passed and is posted as a PR comment** — run the gate and
   post its result to the PR. A merge is blocked if either check is missing,
   failing, or was forgotten.
3. **The samorev PASS is on the exact commit you are merging — re-review after ANY
   post-review commit.** A samorev review is bound to the head SHA it ran against.
   If *any* commit lands after that PASS — a fix, an amend, a rebase, a
   conflict-resolution `Merge origin/main`, or any other push — **the prior review
   is VOID.** You MUST re-run samorev on the new HEAD and get a fresh PASS comment
   **before** merging. **Never merge when the PR's head SHA is newer than the latest
   samorev PASS comment.** Pre-merge check, every single time:

   ```bash
   gh pr view <n> --json headRefOid --jq .headRefOid   # the SHA you are about to merge
   # must equal the commit the latest samorev PASS comment ran against, AND CI must be green on it
   ```

   This closes the real gap where a reviewed PR is changed and then merged
   unreviewed (e.g. a `ci.yml` conflict-merge pushed after PASS — exactly what
   slipped through on PRs #53/#54/#55). CI being green on the new head is **not**
   a substitute for re-running samorev — code analysis must see the merged code.

```bash
# Deterministic gate (CI status + draft state) — posts a PASS/FAIL comment:
bun run samorev review https://github.com/<owner>/<repo>/pull/<n> --fetch
# Read-only (print to stdout, no posting):
bun run samorev review https://github.com/<owner>/<repo>/pull/<n> --no-comment --fetch
```

The Bun CLI gate checks CI status + draft state only. For real code analysis run
the `/review-mr` slash command (or spawn the samorev review agents — Security and
Bug Hunter are blocking), then post a comment with the combined result. Both
surfaces authenticate through `gh`/`glab`; see the repo's `docs/bot-operation.md`.

### GPT review substitution under owner instruction

When the human owner explicitly instructs agents to use GPT reviewers in place of
the Claude-backed samorev analysis, use this path only for the work covered by that
instruction. Tool unavailability alone does not authorize a substitution. Record
the authorization and its scope in the PR; do not launch Claude-backed analysis
contrary to the owner's instruction.

- Run **two independent reviews**, Security and Bug Hunter, with separate GPT
  reviewer agents who did not implement the change. Each reviews the final diff
  and relevant repository context against the **same full head SHA**.
- Post both reviews as PR comments, identifying the role, actual model, full head
  SHA, findings and verdict. Label the result **GPT review substitution**, never
  `samorev PASS`. Preserve any failed or unavailable samorev result truthfully;
  neither failure nor unavailability counts as a passing review.
- **BLOCKING findings from either reviewer block merge** until fixed and
  re-reviewed. NON-BLOCKING / POTENTIAL / INFO retain their existing meaning.
  Missing reviews or an incomplete review also block merge.
- **Any later commit invalidates both reviews**, including fixes, rebases and
  conflict-resolution merges. Obtain fresh Security and Bug Hunter reviews on
  the new head before merge; green CI does not replace either review.
- All required **CI checks must be green on that exact head SHA**, and appropriate
  behavior evidence must be posted (commands and output; screenshots for UI).
  For documentation-only changes, post the diff/consistency checks and explain
  why a live behavior test is not warranted; do not invent red/green tests.
- Confirm the PR head SHA matches both review comments and the green CI results
  immediately before merge. **Explicit human owner merge approval is still
  required**; authorizing GPT review does not authorize a merge.

This substitutes the review provider only. The red/green bugfix requirement,
evidence requirements, sprint handoffs, and other process rules remain in force.

## samograph.dev Build — Engineering Process (v1)

> Source of truth for agentic engineering on the `samograph.dev` SaaS build. Every agent (and human) MUST read this section **and** `blueprints/samograph-dev/SPEC.md` before making changes. The SPEC is authoritative; this section is *how we work*, not *what we build*.
> Provenance: distilled from three postgres-ai reference repos — **pg_ash** (red/green TDD rigor, REV-as-PR-comment gate, release gate), **rpg** (spec-first + sprint/phase labels, ordered no-exceptions PR lifecycle, squash-merge), **pgque** (4-step PR loop with posted real-user evidence, `engineer`/`reviewer` labels, co-authored commits, surgical one-change-per-PR). Adapted to samograph's existing **samorev** merge gate.

### Team shape: a manager + spawned agents
- The orchestrator acts as **engineering manager**: it decomposes a sprint into GitHub Issues, spawns **engineer agents** (one logical track each) and **reviewer agents**, and never lets work bypass the Issue→PR flow. *(pgque `engineer` = "Owned by an engineer agent (do work, open PR)"; `reviewer` = "Awaiting REV-style multi-perspective review".)*
- **All work flows through GitHub Issues & PRs.** No direct commits to `main`; `main` is protected. *(pg_ash: "All changes go through PRs.")*
- **Engineers report intermediate progress as issue comments** — what's red, what's green, blockers, decisions — so the manager and reviewers have a live trail without reading the diff. *(pgque: posted evidence as comments.)*
- One agent owns one Issue at a time; Issues are tightly scoped (one logical deliverable). *(pg_ash: "each confirmed bug gets its own red/green PR"; pgque: "keep changes surgical — one logical fix or feature per PR".)*

### Strict red/green TDD (mandatory)
- **Tests first, always.** Write the failing test (RED), show it fails on the current branch, then implement until it passes (GREEN), then refactor. *(pg_ash + pgque: mandatory for all new code.)*
- The PR description **must show both the RED failure and the GREEN pass** as evidence (paste the failing assertion/output, then the passing run). *(pg_ash PR #108 documents RED error string + GREEN "PASSED".)*
- **Assert exact values, not mere existence** — "a test that only checks a row exists can't distinguish correct aggregation from garbage." *(pg_ash.)* Property/idempotence tests where the SPEC calls for them (e.g. normalizer §6.2 #1).
- For the §6.2 TDD list, the SPEC item number is the contract: each acceptance criterion traces to a `§6.2 #n` red case.
- **Bugfixes are covered by this too — see Development principle 2 above.** A bugfix starts with a test that reproduces the bug and fails on current `main`; no reproducing test, no merge.

### Branches & commits
- **Branch naming:** type-prefixed kebab, embedding the issue number — `feat/<area>-<slug>`, `fix/<n>-<slug>`, `chore/...`, `docs/...`, `test/...`, `ci/...`. Agent branches use `claude/<slug>-<hash>`. *(pgque + rpg + pg_ash all converge on `type/slug`; pgque uses `claude/<slug>-<hash>` for agent branches.)*
- **Commits:** Conventional Commits with scope — `feat(app-api):`, `fix(tokens):`, `test(auth):`, `ci:`, `docs:`, `chore(deps):`. Subject < 50 chars, present-imperative ("add", not "added"). **Never amend a pushed commit; never force-push unless the human explicitly confirms.** *(rpg + pgque.)*
- Agent commits credit actual contributors with accurate coauthor trailers.
  Include a Claude coauthor only when Claude contributed; never add a model name
  or identity that did not contribute. *(pgque coauthor convention.)*
- **One logical change per PR**, focused and easy to review. *(rpg + pgque.)*

### The PR lifecycle — ordered, no steps skipped, LOOP on failure
Every PR walks this loop in order *(merged from rpg's "no exceptions" sequence + pgque's 4-step loop; samorev replaces REV as our gate)*:
1. **CI green.** All checks on the head commit pass: `bun test` and `bunx tsc --noEmit` clean, Postgres-backed integration tests green on the CI ephemeral-Postgres service. If CI is red, fix it first — and if the fix is code, reproduce the failure in a RED test, make it GREEN, then refactor. *(pgque.)*
2. **Review done.** Use samorev by default, or the explicitly owner-authorized
   [GPT substitution](#gpt-review-substitution-under-owner-instruction). For the
   default path, run the merge gate and **post the result as a PR comment**:
   ```bash
   bun run samorev review https://github.com/<owner>/<repo>/pull/<n> --fetch
   ```
   For real code analysis run the `/review-mr` slash command (or spawn the samorev Security + Bug-Hunter agents — both **blocking**) and post the combined verdict. **BLOCKING findings must be fixed and re-reviewed; NON-BLOCKING / POTENTIAL / INFO count as a PASS.** Ignore SOC2 findings (this project does not need them). *(rpg severity model + pgque "ignore SOC2".)*
3. **Actual testing where it makes sense, evidence posted.** Walk the change as a new user / exercise it live (not just unit output) and paste commands + output (+ screenshots for UI) as a PR comment. *(pgque step 3; rpg "built-from-branch" evidence.)*
4. **Re-confirm the review is on the current head, then approve → squash-merge → delete the branch.** Before `gh pr merge <n> --squash`, verify the PR's head SHA equals the SHA recorded in the latest samorev PASS (Merge Gate condition 3), or in both passing GPT substitution reviews — **any commit pushed after the review, including a conflict-resolution merge, voids it and forces a re-run of step 2 on the new HEAD.** If steps 1–3 are not all clean (or a new commit landed), return a concrete fix list and **LOOP from step 1** on the next push. *(rpg squash; pgque loop + delete-branch.)*

**No merge without a review of the merged commit.** A merge is blocked if CI is missing/red, the required review comments are missing or blocking, **any required review is on a different head SHA** (Merge Gate condition 3 or the GPT substitution), or live-test evidence is missing where it was warranted. *(pg_ash: "Never merge without explicit approval from the project owner.")* Human owner approval is required for merge.

### Labels & issues
- **Track labels:** `foundation`, `backend`, `call-path`, `frontend`, `security`, `sre`. **Process labels:** `engineer` (owned by an engineer agent), `reviewer` (awaiting samorev review), `tdd`, `spec`, `tests`, `sprint-v1.0`. Standard GitHub set (`bug`, `enhancement`, `documentation`, `security`) retained. *(pgque label model + rpg sprint-label model — we track sprints via labels, not GitHub milestones.)*
- **Issues read like engineering specs:** Context / In-scope / Out-of-scope / red-green acceptance criteria / exact SPEC refs (`§5.x`, `§6.2 #n`). Umbrella/audit issues enumerate findings, each spinning off its own scoped PR. *(pg_ash + pgque + rpg.)*
- Deferred work is parked with explicit title prefixes — `[POSTPONED post-v1]`, `[ON HOLD v1.1]` — keyed to a target version. *(pgque.)*

### One sprint at a time — STOP for human testing
- We run **one sprint at a time**. The manager does **not** roll into the next sprint automatically. At each *Sprint exit* (SPEC §8), **STOP and hand off to the human for manual testing** against the §6.3 manual plan and the sprint-exit checklist.
- **After every sprint, verify the implementation against the SPEC.** Walk §4/§5/§6.2 and confirm each shipped item matches. **Record every intentional deviation in `blueprints/samograph-dev/SPEC.amendments.md`** (what differs, why, which § it amends) — the SPEC stays the contract; deviations are explicit and reviewed, never silent. *(pg_ash: docs written for "a new user arriving today", no silent drift; pgque: migration notes belong in changelog, not scattered.)*
- Sprints are version-milestone driven (`sprint-v1.0`), not fixed calendar boxes. *(pg_ash release cadence + pgque sprint labels.)*

### Stubs & secrets
- **Stub every external integration behind an interface with an in-repo fake** so Sprint-1 PRs need no real tokens: Recall behind `packages/test-fakes/recall` (deterministic; real Recall sandbox is a nightly job, not a PR gate — SPEC §6.1), email behind a swappable `EmailSender` with an in-memory fake (§5.1), Postgres via the CI ephemeral container.
- **NEVER put real API keys/tokens/secrets in issues, PR comments, or commits — not even for demos.** Secrets live in the secret manager / env. If one leaks, rotate immediately. *(rpg + pgque security hygiene.)*

### Compatibility with the existing samorev merge gate
The repo-level **Merge Gate (samorev)** rules in the root `CLAUDE.md`, including only its explicitly owner-authorized GPT substitution, remain in force. This section *layers* the manager+agents flow, strict TDD-first, and the per-sprint STOP on top of that gate; where both speak, review step 2 above IS that gate.

## Deployment topology & CI/CD — 3-tier preview → prod (TARGET; owner-specified)

> Owner-specified target (2026-07-08). **All deployments go through CI (GitHub Actions)** — no manual VM deploys, no VM-side auto-deploy-on-merge. Three tiers:

| Trigger (via CI) | Environment | URL | Database |
|---|---|---|---|
| **open a PR** for `<branch>` | ephemeral PR preview | `samograph-<branch>.samo.cat` | its own **DBLab** thin-clone / branch |
| **merge to `main`** | canonical main preview | `samograph-main.samo.cat` | its own DBLab clone |
| push a **dated release tag** `vYYYYMMDD.N` | **production** | `samograph.samo.team` | prod DB |

- **Prod deploys ONLY on a release tag** — never on a branch or `main` push. **After the cutover, merging to `main` will no longer ship prod**; it deploys the main *preview*. Production moves only when a new dated tag is cut.
- **Release-tag grammar (samohost `src/commands/app.ts:1212`):** `^v(\d{4})(\d{2})(\d{2})\.([1-9]\d*)$` — e.g. `v20260904.1`. A tag deploys only if it is **strictly newer** than the last deployed tag, its SHA is an **ancestor of `main`**, and **CI is green on that exact SHA** (`.github/workflows/ci.yml`, pinned by `releaseCiWorkflow` in `.samohost.toml`). Old npm tags (`v0.x`) never match and are ignored. Cut tags with `.github/workflows/release.yml`; operator checklist in `docs/runbooks/deploy-release.md`.
- **DBLab** (postgres.ai Database Lab Engine) gives each preview an isolated, production-like database via a thin **clone/branch** (cheap, fast). Previews are created **per OPEN PR** (by `samohost trigger run --pr-previews` on a 5-minute timer), **not** per branch push, and are torn down when the PR is closed/merged.
- Entrypoints: prod/preview app-api = `apps/app-api/server.ts` with `SAMO_ENV=<prod|preview>` (fail-closed on missing/dev-default secrets); local dev = `apps/app-api/dev-server.ts` + `SAMO_ENV=dev`. Live stack (ingest+ws-hub composed) = `apps/ws-hub/dev-live-server.ts`.

### Current machinery — the VM "samohost" system (as of 2026-07-08; some details still being mapped)
- Hetzner VM: `ssh -p 2223 dev@116.203.249.135` (root via passwordless `sudo`). A **"samohost"** system already provides per-env previews: templated systemd units `samograph-web@<env>` / `samograph-live@<env>`, per-env checkouts under `/opt/samograph/envs/<env>`, a per-env `.env` with a DBLab-derived `DATABASE_URL`, per-env Caddy site config, and per-env ports.
- **Real prod** = `/opt/samograph/app` (units `samograph-web.service` / `samograph-live.service`) → **`samograph.samo.team`**. The `@samograph-main` instance → `samograph-main.samo.cat` is a **preview** (NB: earlier handoff docs mislabel samo.cat as prod — it is not).
- ⚠️ **Current mapping is WRONG vs the target:** samohost currently auto-deploys `main` → **prod (`samo.team`)**, un-tag-gated, and `samograph-main.samo.cat` is a stale preview. Target: `main` → the main *preview*; **prod only on a dated release tag**. The control plane polls on a **5-minute** timer (an earlier note said ~3 min).
- ✅ **Prod entrypoint: FIXED.** `/opt/samograph/start-prod.sh` now execs `apps/app-api/server.ts` (it previously execed `dev-server.ts`, which refuses to boot under `SAMO_ENV=prod`). A service restart is safe; the earlier "coasting on a stale process" warning no longer applies.
- ⚠️ **No standing main-preview auto-refresh** (samohost issue #150). The `--branch main` env must be created once by hand (`samohost env create <vm> samograph --branch main --db dblab`) and does not redeploy on new `main` commits until #150 lands.
- Being mapped (read-only VM investigation): the DBLab endpoint/version/token, Caddy wildcard + on-demand TLS, Cloudflare `*.samo.cat` DNS + API token, and the exact samohost trigger/entrypoint a CI job would call.

### To build
1. **GitHub Actions workflows** for the three triggers, each driving samohost (via an SSH deploy command or a samohost API) to create/update the right env + its DBLab clone.
2. **Fix the trigger mapping:** stop auto-deploying `main` → prod; make `main` → `samograph-main` preview; add a **tag → prod** deploy that cuts prod over to `server.ts` + `SAMO_ENV=prod` and applies migrations.
3. **DBLab branching per preview** + teardown on branch delete/merge.
4. **DNS:** Cloudflare wildcard `*.samo.cat` + Caddy on-demand TLS so arbitrary branch names resolve.
5. **GitHub Actions secrets:** a deploy key (or samohost API token), a DBLab token, a Cloudflare DNS token. **Never commit secret values** (they live in the secret manager / GH Actions secrets).
6. **Incremental, non-breaking rollout:** don't disturb the currently-live prod/preview until each tier is proven.

**Access status (2026-07-08):** VM root ✓; GitHub (PRs + `gh`) ✓; DBLab token / Cloudflare DNS token / ability to set GH Actions secrets = to confirm or obtain from the owner.