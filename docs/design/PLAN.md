# samograph web — Design system PR plan

Ordered PR lists implementing [`DESIGN-MODEL.md`](./DESIGN-MODEL.md), split into a desktop track
(PR 1–14, from the original `/settings`-centred audit) and a mobile track (M1–M9, additive on top
of PR 2). Each PR is 1–3 files and independently mergeable. Status as of 2026-09-04.

Findings backing this plan: [`AUDIT-2026-09-04.md`](./AUDIT-2026-09-04.md).

**Status:** the statuses below are updated per PR — check the PR itself for the current merge/review state if this doc lags.

---

## Desktop track — PR 1–14

| # | Status | PR | Files | Why here |
|---|---|---|---|---|
| **1** | **merged (#278)** | `fix(web): real Select control — end-cap chevron, sized to content` | `globals.css`, `SettingsPage.tsx`, `SettingsPage.test.tsx` | The reported complaint. Adds `.samograph-select` wrapper + `appearance:none` + end-cap; introduces `--control-h`, `--radius-control`, `--field-max`. |
| **2** | **merged (#279)** | `fix(web): one control height — 44/36/28` | `globals.css` (+ `AddToCallForm.tsx` if the grid needs it) | Retires the five inconsistent heights. Input, select and the hero button line up. Pure CSS + tokens. **Base height is 44px per the DESIGN-MODEL §2 deviation (WCAG target size), not the 36px the original audit proposed.** |
| 3 | not started | `fix(web): stop Settings buttons stretching full-width` | `globals.css`, `CalendarConnectionCard.tsx` | Splits `.samograph-signin`'s grid from the calendar card; adds `.samograph-actions` around button pairs. |
| 4 | not started | `fix(web): align page content with the app nav` | `globals.css`, `apps/web/app/settings/page.tsx` | `--prose`/`--form` constrain the inner column, not `<main>`. Large perceptual win, small diff. |
| 5 | not started | `feat(web): PageHeader component` | `components/PageHeader.tsx` (new), `globals.css`, `OwnerCallView.tsx` | Title/description/back/actions. Moves the raw meeting URL out of the `/calls/[id]` H1. |
| 6 | not started | `fix(web): section rhythm and a real h2 scale` | `globals.css` | `h2` → `--text-lg`; `.samograph-settings-section` → `.samograph-section` with a 1px rule and `--space-6` rhythm. |
| 7 | not started | `fix(web): button borders, disabled state, dark-mode legibility` | `globals.css` | Declares `border` on the base; `--secondary` text → `--ink-soft`; disabled gets a background, not just opacity. |
| 8 | not started | `feat(web): Alert with a tone rail, icon, and readable copy` | `globals.css`, `components/Alert.tsx` (new) | Ink copy + coloured rail; `--inline` variant for the savebar. Must keep `test/alert-contrast.test.ts` green. |
| 9 | not started | `feat(web): real switch for auto-record` | `globals.css`, `CalendarConnectionCard.tsx` | Makes `role="switch"` look like a switch. |
| 10 | not started | `feat(web): skeletons everywhere a sentence used to be` | `components/PageSkeleton.tsx`, `SettingsPage.tsx`, `CalendarConnectionCard.tsx` | Adds `variant="row" \| "panel"`; deletes the three "Loading …" paragraphs. |
| 11 | not started | `feat(web): dashboard row — meeting title, meta column, closer CTA` | `globals.css`, `Dashboard.tsx` | Three-column row; URL demoted to the secondary line. |
| 12 | not started | `fix(web): dark-mode hairlines and instrument button variant` | `globals.css` | Lifts `--line` in dark; replaces hand-written in-panel button rules with `--on-panel`. |
| 13 | not started | `fix(web): converge the landing on the app's control geometry` | `globals.css`, `Landing.tsx`, `components/__fixtures__/landing.baseline.html` | Merges `.samograph-button` into `.samograph-btn`. Touches the baseline fixture — do last among 1–13. |
| 14 | not started | `chore(web): split globals.css into layers` | `globals.css` → `styles/{tokens,base,components,pages}.css` | Only after 1–13 land — re-organising first would make every prior diff unreviewable. |

**Cross-cutting notes**
- PRs 1–4, 6–7 and 12 are CSS-only and should not move a single test (tests query by role/label,
  not class). PRs 3, 5, 9, 10, 11 change markup and need test updates.
- `apps/web/components/__fixtures__/landing.baseline.html` + `Landing.baseline.test.tsx` pin the
  landing markup — PR 13 must update the fixture in the same commit.
- `apps/web/test/greenroom-tokens.test.ts` pins the `--google-btn-*` values literally — do not
  touch them in any PR.
- `test/no-dead-css.test.ts` and `test/css-tokens-defined.test.ts` both read `globals.css` by
  path — this is why PR 14 (splitting the stylesheet) must come last.

---

## Mobile track — M1–M9

Additive on top of desktop PR 2 (`feat/web-control-height`). The `globals.css region` column is
the conflict surface — PRs touching disjoint regions can run in parallel.

| # | Status | PR | Files | globals.css region | Parallel with |
|---|---|---|---|---|---|
| **M1** | **in review (#280)** | `fix(web): transcript reflows to two rows below 1024` | `globals.css` | instrument/transcript block only | M2–M9 |
| **M2** | in progress | `fix(web): real mobile nav — 56px shell, disclosure menu` | `globals.css`, `AppShell.tsx`, `AppShell.test.tsx` | app nav block | M1, M3–M9 |
| **M3** | in progress | `fix(web): 44px touch targets + a 12px type floor` | `globals.css` | base rules + button block, new `@media` block | M1, M2, M5–M9 |
| **M4** | in progress | `fix(web): collapse the call-view header on mobile` | `globals.css`, `OwnerCallView.tsx` | call view + panel head block | M2, M3, M5–M9 |
| M5 | not started | `fix(web): landing footer separators + mobile wordmark` | `globals.css`, `Landing.tsx`, `__fixtures__/landing.baseline.html` | landing block only | all |
| M6 | not started | `fix(web): savebar stops overlapping content; safe-area insets` | `globals.css`, `app/layout.tsx` | savebar block + `:root` | M1, M2, M4, M5 |
| **M7** | in progress | `fix(web): dashboard row — title, meta, no query strings` | `globals.css`, `Dashboard.tsx`, `Dashboard.test.tsx` | dashboard row block | M1–M6, M8, M9 |
| M8 | not started | `fix(web): iOS-safe form fields (16px, full-width, one geometry)` | `globals.css` | base + auth blocks | M1, M2, M4, M5, M7 |
| M9 | not started | `chore(web): tokenise breakpoints and the fluid gutter` | `globals.css` | `:root` + every `@media` header | last — rebase others onto it |

**Scope per PR**

- **M1 — transcript reflow** (ship first; highest value). Two-row grid below `--bp-lg`: utterance
  width grows from ~114px to the full content width at 390px. Must not touch `.samograph-percall`
  colours or `--speaker-*` tokens; re-read `test/transcript-instrument-css.test.ts` first.
- **M2 — mobile nav.** Deletes the `flex-wrap: wrap` patch. Below `--bp-md`: brand + `☰` (44×44,
  `aria-expanded`/`aria-controls`); disclosure holds email, theme switcher, Log out. Nav height
  129px → ≤56px.
- **M3 — touch targets + type floor.** One `@media (max-width: 767px)` block: `min-height: 44px`
  on action elements; theme-switcher option text 10.88px → 12px; back-link target 20px → 44px;
  `--sm`/`--xs` button variants neutralised below `--bp-md`. Pure CSS — no test should move.
- **M4 — call-view header.** `<h1>` becomes the meeting name (or `Call · <date>`); URL demotes to
  a `--text-sm` mono description line. Panel header collapses below `--bp-md` to state chip +
  timer, with id/URL/dictionary moved into a `<details>`. Removes ~200px of chrome above the
  first transcript line.
- **M5 — landing.** Footer `·` separators move out of inline-flow (`span + span::before`) or drop
  below 480px; wordmark shrinks instead of hiding at the mobile breakpoint; `.samograph-instrument`
  `min-width: 780px` → `min-width: min(780px, 100%)`. Must update
  `__fixtures__/landing.baseline.html` in the same commit.
- **M6 — savebar + safe area.** Savebar gets `box-shadow` via a new `:root`-declared `--elev-*`
  token, spans the ground instead of floating, gets safe-area bottom padding; adds
  `export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" }` to
  `app/layout.tsx`.
- **M7 — dashboard row.** Title line / meta line (date · duration · status) / chevron. Display
  URLs as `origin + pathname` only — **query strings are never rendered** (closes the `?pwd=`
  join-secret leak). `Dashboard.test.tsx` needs updating for the markup change.
- **M8 — form fields.** `input/select/textarea` → 16px font below 480px (iOS zoom fix), full
  width; unifies the `/auth` stack around one reference height. Does not touch `--google-btn-*`
  (pinned by `test/greenroom-tokens.test.ts`).
- **M9 — breakpoint tokens** (last). Documents `--bp-sm/md/lg` in the `:root` comment block;
  normalises `59.99rem`/`48rem`/`40rem` to the new pixel breakpoints; makes `--gutter` fluid.
  Touches every `@media` header — rebase M1–M8 onto it, not the reverse.

---

## Status legend

- **merged** — landed on `main`.
- **in review** — PR open, awaiting/undergoing samorev review per the repo merge gate.
- **in progress** — actively being worked (branch exists or an agent/engineer owns it), not yet a
  reviewable PR.
- **not started** — scoped, not yet begun.
