# Runbook — production release via deploy tag

**Audience:** operator cutting a samograph production release after the samohost
deploy-topology cutover.

**Target topology**

| Trigger | Environment | URL |
|---|---|---|
| open PR | PR preview | `samograph-<branch>.samo.cat` (own DBLab clone) |
| merge to `main` | main preview | `samograph-main.samo.cat` (own DBLab clone) |
| release tag `vYYYYMMDD.N` | **production** | `samograph.samo.team` (prod DB) |

**Merging to `main` does not ship prod.** After the cutover, production moves
only when a new deploy tag appears.

## Tag grammar (non-negotiable)

samohost's deploy channel accepts a tag only if it matches
(`NikolayS/samohost src/commands/app.ts:1212`):

```
^v(\d{4})(\d{2})(\d{2})\.([1-9]\d*)$      e.g. v20260904.1, v20260904.2
```

and all of:

1. It is **strictly newer** than the last deployed tag (ordered by date, then `N`).
2. Its SHA is an **ancestor of `main`**.
3. **CI is green on that exact SHA** — the workflow pinned by `releaseCiWorkflow`
   in `.samohost.toml` (`.github/workflows/ci.yml`, which runs on `tags: ['v*']`).

Old npm-era tags (`v0.8.0`, …) never match and are ignored by the deploy channel.

---

## Step 0 — restore PR previews first

Do this **before** anything else; a broken preview lane means the cutover has no
safety net.

```bash
# on the control plane
cd <samohost checkout>
git log -1 --format='%h %ad %s' --date=short     # must be >= 2026-07-14 / d940168
systemctl cat samohost-trigger.timer samohost-trigger.service | grep -- --pr-previews
samohost trigger run --pr-previews --dry-run
```

- Checkout older than `d940168` (2026-07-14) → pull and restart the timer.
- Missing `--pr-previews` on the service unit → previews never get created; add it.
- The dry run should list one preview per **open PR**. Previews are per open PR,
  **not** per branch push.

## Step 1 — register the manifest

```bash
samohost app register <vm> --from-toml .samohost.toml
```

- There is **no `--force` flag**. If a stale comment or note tells you otherwise,
  it is wrong.
- Register is **state-only**: it records the manifest and the release policy. It
  does **not** deploy anything.
- From this moment, `main` pushes stop shipping prod. See the freeze risk below.

## Step 2 — dry-run the release channel

```bash
samohost trigger run --app samograph --dry-run
```

Expected output: **`no-matching-tag`** — no tag in the repo satisfies the dated
grammar yet, so prod correctly stays put. Anything else (an attempted deploy, a
validation error) means stop and investigate before cutting a tag.

## Step 3 — create the main preview

```bash
samohost env create <vm> samograph --branch main --db dblab
```

Gives `samograph-main.samo.cat` its own DBLab clone.

> **Known gap — samohost#150:** there is no standing main-preview auto-refresh.
> This env is created once and will **not** redeploy on new `main` commits until
> samohost#150 lands. Refresh it manually (`samohost env deploy <vm> samograph-main`)
> when you need it current.

## Step 4 — cut the first tag

Preferred — the repo workflow does the date/`N` arithmetic and the CI-green check
for you:

```
Actions → "Cut production release tag" → Run workflow (main)
```

Run it once with **dry run = true** to see the computed tag, then for real.

Manual equivalent:

```bash
gh run list --workflow=ci.yml --branch=main --limit=1        # must be success on main HEAD
SHA=$(git rev-parse origin/main)                             # the SHA CI greened
TAG=$(git tag --list 'v*' | ./scripts/next-release-tag.sh "$(date -u +%Y%m%d)")
gh release create "$TAG" --target "$SHA" --title "$TAG" --generate-notes
```

`N` is **max(N already used today) + 1**, never "the first free N" — deleting
`v20260904.5` out of `.1 … .12` must not make us reuse `.5`, which is older than
`.12` and would be rejected by the strictly-newer rule. `scripts/next-release-tag.sh`
does that arithmetic (and the strictly-newer check) and is unit-tested.

Always target the **SHA**, not `main`: `--target main` re-resolves the branch at
creation time and can tag a commit CI never greened.

`.github/workflows/npm-publish.yml` has a guard job that detects this tag shape
and **skips the npm publish** the `release: published` event would otherwise fire.

## Step 5 — verify prod

The control plane polls on a 5-minute timer.

```bash
sleep 300
curl -sI https://samograph.samo.team | head -1                 # 200
curl -s  https://samograph.samo.team/health                    # ok
gh api repos/NikolayS/samograph/commits/main --jq .sha         # compare to deployed SHA
```

On the VM: `systemctl status samograph-web samograph-live` and
`journalctl -u samograph-web -n 100` if either is unhealthy.

---

## Risks

- **Prod freezes between Step 1 and Step 4.** Registering the manifest disables
  the old `main → prod` auto-deploy, but nothing ships until the first dated tag
  exists. Any `main` commit landed in that window is not on prod. **Do Steps 1–4
  in a single session**, and do not register at the end of a working day.
- **Preview auth is broken by `WEB_ORIGIN` + non-BYPASSRLS clone role.** Previews
  inherit a prod-pointed `WEB_ORIGIN` and a DBLab clone login role that lacks
  `BYPASSRLS`, so magic-link login fails on preview envs. Do not read a preview
  login failure as a regression in the change under test; the durable fix belongs
  in samohost provisioning.
- **DBLab `maxIdleMinutes`.** Idle clones are reclaimed. A preview left alone long
  enough comes back with a dead `DATABASE_URL`; recreate the env rather than
  debugging the app.
- **CI must be green on the tag SHA itself**, not merely on `main`. CI runs on
  `tags: ['v*']` so the tag gets its own run — if that run is red or missing,
  samohost will not deploy the tag, and the fix is a new commit plus a new tag
  (never a moved tag).
