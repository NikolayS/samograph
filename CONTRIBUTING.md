# Contributing to samograph

Short version of how we work. `CLAUDE.md` is the full process document — read it
before your first change; this file is the day-to-day summary.

## Running the tests

```bash
bun test            # unit + integration tests
bunx tsc --noEmit   # type check
```

Both must be clean locally before you open a PR, and green in CI before it merges.

## Branches & commits

- Branch names are type-prefixed kebab-case: `feat/<area>-<slug>`, `fix/<n>-<slug>`,
  `docs/...`, `test/...`, `chore/...`, `ci/...`.
- Commits follow Conventional Commits with a scope: `fix(orchestrator): survive sweep errors`.
  Subject under 50 chars, present-imperative ("add", not "added").
- Never amend a pushed commit; never force-push without explicit human confirmation.
- One logical change per PR.

## PR lifecycle

1. **CI green** on the head commit (`bun test`, `bunx tsc --noEmit`, integration tests).
2. **samorev review posted** as a PR comment. BLOCKING findings must be fixed and
   re-reviewed; NON-BLOCKING / POTENTIAL / INFO count as a pass.
3. **Evidence posted** — exercise the change for real (commands + output, screenshots
   for UI) as a PR comment.
4. **Re-review after ANY post-review commit.** A review is bound to the head SHA it ran
   against; a fix, rebase, or conflict-resolution merge voids it. Green CI is not a
   review.
5. **Squash-merge** and delete the branch, once the latest PASS is on the exact SHA
   being merged. **Human owner approval is required for merge.**

## Bugfixes are red/green TDD — no exceptions

Every bugfix PR starts with a failing test. A test written after the fix proves nothing.
"Confirmed in prod" or "verified in the logs" is not a substitute — it fixes today's
incident and leaves nothing behind to catch the regression. **A bugfix PR without a
reproducing test is rejected at review**, however small the diff.

Three steps, and the PR description pastes the output of steps 2 and 3:

1. **Write the reproducing test** in the file next to the code under test:

   ```ts
   // apps/bot-orchestrator/statusPoller.test.ts
   test("sweep keeps polling after one bot errors", async () => {
     const poller = makePoller([failingBot, healthyBot]);
     await poller.sweep();
     expect(healthyBot.polled).toBe(true); // assert the exact value, not "it exists"
   });
   ```

2. **Show it RED** on unfixed `main` — paste the failure into the PR:

   ```text
   $ bun test apps/bot-orchestrator/statusPoller.test.ts
   error: expect(received).toBe(expected)  Expected: true  Received: false
   1 fail
   ```

3. **Fix the code, show it GREEN** — paste the passing run into the same PR:

   ```text
   $ bun test apps/bot-orchestrator/statusPoller.test.ts
   1 pass, 0 fail
   ```

Then refactor if needed, with the test still green.

If a bug genuinely cannot be expressed as an automated test, say so explicitly in the PR
and get that exception agreed by the reviewer *before* merge.

## More

See `CLAUDE.md` for the full engineering process: agent/manager workflow, issue and label
conventions, the samorev merge gate in detail, and deployment topology.
