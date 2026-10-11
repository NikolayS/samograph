# samograph web — Design Model v1

The design system for `apps/web`: principles, tokens, component specs, and the layout +
responsive model. Cite this doc from PRs that touch `globals.css` or
any shared component.

Companion docs: [`AUDIT-2026-09-04.md`](./AUDIT-2026-09-04.md) (the findings this model answers)
and [`PLAN.md`](./PLAN.md) (the ordered PR list and current status).

---

## 1. Principles

1. **The transcript is the product; the app is the frame.** The dark instrument panel is the
   one place that gets density, colour and motion. Everything around it — nav, forms, lists —
   is quiet, warm, near-monochrome, and gets out of the way. Any decoration that competes with a
   running transcript is wrong.
2. **One control geometry.** Every interactive box in the app — button, input, select, the
   theme switcher — is one of a small set of shared heights, `--radius-control`,
   `--control-border`, and one focus treatment. If two controls sit on a line they are the same
   height, always.
3. **Hairlines, not boxes.** Structure comes from 1px rules and whitespace on the warm ground,
   not from nested cards and shadows. Elevation is reserved for things that genuinely float:
   modals, the savebar, the jump-to-live pill.
4. **Every state is designed.** Loading is a skeleton of the thing that is coming; empty says
   what to do next; error names what failed and offers the next action. No page ever shows a
   bare sentence where a component belongs.
5. **Mobile is not desktop squeezed.** Below the reflow breakpoints, layouts change shape
   (columns → rows, sticky → static, four-column grids → two-row stacks) instead of shrinking
   proportionally. A "responsive" rule that only lowers a font size or narrows a column is not
   done.

---

## 2. Deviation from the source audit

> **Button base height is 44px (not 36px), with a `--sm` variant at 36px.**
> **Rationale: WCAG 2.5.5 target size.** The original audit (`AUDIT-2026-09-04.md`) proposed
> `--control-h-compact: 36px` as the *default* button height, matching the historical
> `.samograph-btn`. That default is below the 44×44 CSS px target size recommended by WCAG 2.2
> SC 2.5.5 (Target Size, AAA) and flagged as a target-size risk at AA under 2.5.8 for closely
> spaced controls. This model instead makes **44px the button base/default** and demotes 36px to
> the explicit `--sm` variant for dense, non-primary contexts (in-panel toolbars, table row
> actions) where the audit's own mobile pass already required 44px targets anyway
> (`AUDIT-2026-09-04.md` §Mobile, "Touch targets ≥ 44px"). This keeps one rule instead of two:
> primary and form actions are always touch-safe by default; only visually-dense, low-risk
> controls opt down.

All other token values below match the source audit as merged with the mobile responsive model.

---

## 3. Tokens

Additions to `:root` in `apps/web/app/globals.css`. Existing tokens stay; nothing is renamed.

```css
/* Control geometry — the single answer to "how tall is a control?" */
--control-h: 44px;           /* default: buttons, inputs, selects, nav, forms */
--control-h-sm: 36px;        /* dense rows, in-panel toolbars, table actions (--sm variant) */
--control-h-xs: 28px;        /* inline row actions only, desktop-only (never below --bp-md) */
--control-pad-x: var(--space-4);
--radius-control: var(--radius-md);   /* 6px — buttons AND fields, one value */
--field-max: 22rem;          /* a select/short input never spans the column */

/* Elevation — three steps, no more */
--elev-0: none;
--elev-1: 0 1px 2px color-mix(in srgb, var(--ink) 8%, transparent);
--elev-2: 0 4px 16px color-mix(in srgb, var(--ink) 12%, transparent);
--elev-3: 0 12px 40px color-mix(in srgb, var(--ink) 18%, transparent);

/* Motion */
--dur-fast: 120ms;
--dur-base: 180ms;
--dur-slow: 320ms;
--ease: cubic-bezier(.2, 0, 0, 1);

/* Focus */
--focus-w: 2px;
--focus-offset: 2px;

/* Layering */
--z-sticky: 10;
--z-skip: 100;
--z-modal: 1000;

/* Breakpoints — three, mobile-first (documentation; custom props can't be used in @media) */
/* --bp-sm: 480px  — two-up action rows, meta inline, 16px form fields (iOS zoom fix) */
/* --bp-md: 768px  — list rows go 3-column, forms side-by-side, nav un-collapses */
/* --bp-lg: 1024px — nav spreads, transcript takes its 4-column form */
```

**Colour roles** — unchanged, plus two:

```css
--field-bg: var(--surface);
--field-bg-disabled: color-mix(in srgb, var(--muted) 8%, var(--surface));
```

**Type scale** — keep the seven steps, fix the hierarchy by *use*, not by size:

| role | token | weight | use |
|---|---|---|---|
| page title | `--text-xl` 28px | 700, `-.02em` | one per page, in `PageHeader` |
| section title | `--text-lg` 20px | 600, `-.01em` | `<h2>` — was 16px, the flatness bug |
| subsection | `--text-md` 16px | 600 | `<h3>` |
| body | `--text-base` 14px | 400 | prose, field values |
| label | `--text-sm` 13px | 600 | field labels, table headers |
| hint / meta | `--text-xs` 12px | 400, `--muted` | hints, timestamps, chips |

Add `--text-2xs: 0.6875rem` (11px) **only** for the tabular transcript line-number gutter — every
other size floor is 12px, and content the user reads (utterances, body prose, field values) never
drops below 14px.

**Spacing rhythm** — only `--space-2/3/4/5/6/8/12` are used inside components; `--space-10/16`
are page-level only. Ban raw px in new rules.

**Radius** — `--radius-control` (6) for every interactive box; `--radius-lg` (8) for cards and
panels; `--radius-pill` for chips and the switcher.

**Fluid gutter** — `--gutter: clamp(16px, 5vw, var(--space-8))`, replacing the `:root` override
inside a `40rem` media query with one expression that covers the 20px mobile gutter and the 32px
desktop gutter.

---

## 4. Component specs

### Button — `.samograph-btn`
```
base      height var(--control-h) [44px — see §2 deviation]; padding 0 var(--control-pad-x);
          border: 1px solid transparent;          ← declare it, don't inherit from `button`
          border-radius: var(--radius-control);
          font: var(--text-sm)/1 500; gap var(--space-2);
          transition: all var(--dur-fast) var(--ease);
sizes     --sm  height var(--control-h-sm) 36px, --text-xs  (dense/desktop contexts only)
          --xs  height var(--control-h-xs) 28px, desktop-only, never below --bp-md
variants  --primary    ink fill / ground text / border ink
          --secondary  transparent / --ink-soft text / border control-border  (not --muted —
                       a secondary button must not read as disabled)
          --ghost      transparent / muted text / border transparent
          --danger     transparent / crit text / border crit
          --danger --solid  crit fill / white
          --on-panel   panel-ink text / border panel-gutter   ← replaces hand-written
                       in-panel button rules
states    :hover     primary → 88% ink; others → --hover-surface + border --ink
          :focus-visible  outline var(--focus-w) solid var(--focus-ring); outline-offset var(--focus-offset)
          [disabled] opacity .45 AND background var(--field-bg-disabled) AND border --line
                     — never opacity alone (the dark-mode illegibility bug)
          [aria-busy] cursor progress + a 12px spinner in the leading slot
width     never stretches. `width: fit-content` unless inside `.samograph-actions--block`
          (the mobile / empty-state case).
mobile    below --bp-md, --sm and --xs are neutralised back to --control-h (44px) — dense
          variants are a desktop-only affordance.
```

### TextField — `.samograph-field` + `input`
```
label     --text-sm / 600 / --ink, margin-bottom var(--space-2)
input     height var(--control-h); padding 0 var(--space-3);
          border 1px solid var(--control-border); border-radius var(--radius-control);
          background var(--field-bg); font var(--text-base)
hint      .samograph-field-hint — --text-xs / --muted, margin-top var(--space-2)
error     [aria-invalid="true"] → border-color var(--crit); message renders in
          .samograph-field-error (--text-xs / --crit) inside the field group,
          not as a detached page-level alert
disabled  background var(--field-bg-disabled); color var(--muted); cursor not-allowed
focus     outline only — one focus signal, no competing border-color change
width     max-width var(--field-max) unless .samograph-field--wide (URLs, keyterms)
mobile    below --bp-sm (480px): font-size 16px on input/select/textarea (stops iOS
          zoom-on-focus); full width, --field-max yields
```

### Select — `.samograph-select` (shipped: PR 1, #278)
```
wrapper   position relative; display inline-grid; width 100%; max-width var(--field-max)
                     ← not full column width for a short enum; this is what actually kills
                       the "tiny chevron floating in a wide field" complaint
select    appearance: none (the missing rule); width 100%; height var(--control-h);
          padding 0 calc(var(--control-h) + var(--space-2)) 0 var(--space-3)
                     ← right padding reserves exactly the end-cap's width
          color --ink; background --field-bg; border 1px solid --control-border;
          border-radius var(--radius-control); cursor pointer
end-cap   a ::after pseudo-element, full-height, pointer-events:none (keeps the whole
          control one hit target), separated from the value by a --line hairline, holding
          a 10×6 chevron drawn via mask-image in --muted (not a hard-coded SVG stroke —
          must follow the colour per theme)
states    :hover on wrapper → --hover-surface on the cap; :focus-visible on the select →
          the shared focus outline; :disabled → --field-bg-disabled / --muted
```
Native `<select>` stays the element — no JS listbox; keyboard, mobile wheel pickers and screen
readers all keep working. At 390px, `--field-max` (352px) already exceeds the content box, so the
control is effectively full-width on mobile with no extra rule needed.

### Textarea
Same box as TextField, `min-height: 8rem`, `resize: vertical`, normal line-height. Mono font
only on `.samograph-keyterms` — not on the bare `textarea` selector.

### Checkbox / Toggle — `.samograph-toggle`
Two forms, one class family:
- **Checkbox** (`input[type=checkbox]`): `accent-color: var(--ink)`, 18×18px, aligned to the
  label's first line via `margin-top: .15em`.
- **Switch** (`role="switch"`): a real track — `appearance:none; width 40px; height 24px;
  border-radius: var(--radius-pill); background: var(--line-strong)`, with a `::before` 18px
  knob translating 16px on `:checked` over `--dur-base`, track → `--ink`. The pixels must match
  the announced semantics.

### Alert / Banner — `.samograph-alert`
```
layout    grid-template-columns: 20px 1fr; gap var(--space-3);
          padding var(--space-3) var(--space-4); border-radius var(--radius-control)
tone      border-left: 3px solid <tone>; border: 1px solid --line; background: 6% tint of <tone>
          text: var(--ink) — NOT the tone colour. The tone lives in the rail + icon.
icon      a 16px glyph in the leading column, per tone
sizes     --inline  single-line, --text-xs, no icon — for the savebar status
```

### Card / Section
Two containers, and only two:
- **`.samograph-section`** — a run of related content on the page ground. `border-top: 1px solid
  var(--line)` (1px, not `--line-strong`), `padding-block: var(--space-6)`, `<h2>` at 20px/600
  with an optional `--text-sm/--muted` description under it.
- **`.samograph-card`** — `background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius-lg); padding: var(--space-5); box-shadow: var(--elev-1)`. For
  things that are objects rather than page regions.

### Page header — `.samograph-page-header`
```tsx
<PageHeader title={…} description={…} back={…} actions={…} />
```
`display: grid; gap: var(--space-2); margin-bottom: var(--space-8)`; optional back link above the
title at `--text-sm/--muted`; title `--text-xl/700`; description `--text-base/--muted`,
`max-width: 60ch`; actions right-aligned on `≥--bp-md`, below on mobile. On `/calls/[id]` the
title becomes the meeting name (or `Call · <date>`); the URL drops to the description line in
mono — a URL is metadata, not a title.

### List row — `.samograph-row`
```
grid      "primary meta cta" / minmax(0,1fr) auto auto; gap var(--space-4)
padding   var(--space-4) var(--space-3)
sep       border-top: 1px solid var(--line); last-child border-bottom
states    hover/focus-within → --hover-surface; focus-visible → inset 2px outline
primary   --text-base/600 --ink, truncating; secondary line --text-sm/--muted
mobile    stacks to title / meta line (date · duration · status) / chevron; the whole row
          becomes one 56px-min tap target. Display URLs as origin+path only — the query
          string is never rendered (join secrets like `?pwd=…` must not leak into the row).
```

### Empty state — `.samograph-empty`
`.samograph-card`, centred, `max-width: 44ch`: optional 24px glyph, `--text-md/600` title,
`--text-base/--muted` sentence, and **one** `--primary` action. Every list and every failed
section gets one.

### Skeleton — `.samograph-skeleton`
`variant="form" | "page" | "row" | "panel"` so the placeholder has the shape of what is arriving.
Replaces bare `<p role="status">Loading …</p>` sentences; keep the visually-hidden "Loading…" for
assistive tech.

---

## 5. Layout + responsive model

### Desktop shell
```
shell      nav  height 64px, --surface, border-bottom 1px --line, inner max-width --width-app
page       .samograph-page  max-width var(--width-app); padding var(--space-8) var(--gutter) var(--space-16)
           .samograph-page--prose / --form  narrow the *content*, not the page
```

**Alignment fix:** `--prose` / `--form` must not re-centre `<main>`. Keep `<main>` at
`--width-app` so its left edge tracks the nav; constrain the inner column instead:
```css
.samograph-page--prose > *,
.samograph-page--form  > * { max-width: var(--width-prose); }
```

**Section rhythm:** `--space-8` (32) between sections, `--space-5` (20) between fields inside
one, `--space-2` (8) between a label and its control or a control and its hint. Rule: *the gap
between two things is smaller than the gap around the group they belong to.*

**Form grid:**
```css
.samograph-form { display: grid; gap: var(--space-5); max-width: var(--width-form); }
.samograph-form--split { grid-template-columns: minmax(0,1fr) minmax(0,1fr); }  /* ≥--bp-md */
```
Short enums and short inputs take `--field-max`; only URLs, emails and keyterms go full column.

### Breakpoints — three, mobile-first (`min-width`)

```
base        < 480px    one column, everything full-bleed within the gutter
--bp-sm     480px      two-up action rows, meta inline, 16px form fields (iOS zoom fix)
--bp-md     768px      list rows go 3-column, forms side-by-side, nav un-collapses
--bp-lg     1024px     nav spreads, transcript takes its 4-column form
```
Author new rules `@media (min-width: …)`. Convert legacy `max-width` blocks opportunistically.

### Nav collapse
Below `--bp-md`: brand + a single `☰` disclosure (44×44, `aria-expanded`/`aria-controls`) on row
one; account email, theme switcher and Log out move into the disclosure panel; primary links stay
visible as a second row only if they fit. Target: nav ≤ 56px on mobile. The account email gets
`text-overflow: ellipsis; white-space: nowrap` and never wraps.

### Transcript reflow (the centrepiece of the mobile model)
Below `--bp-lg`, drop the four-column grid entirely and reflow each transcript row to **two rows,
not four columns**: `grid-template-columns: 1fr` with `grid-template-areas: "meta" "utterance"`,
8px/12px padding, 13px base font. The line number is dropped or demoted to a 12px superscript in
the meta line; date/time and speaker share one inline `meta` row (`--panel-muted`, 12px); the
utterance gets its own row at 14px/1.5 line-height, spanning the full content width instead of a
fixed ~114px column. Time renders as `18:08:28` only — date becomes a section divider or a
`title=` attribute — and the speaker name is never ellipsised. Also drop
`max-height: min(62vh,680px)` below `--bp-md` so the panel scrolls with the page, not against it,
and collapse the sticky panel header to one line (state chip + timer) with call id / URL /
dictionary moving into a `<details>`.

### Touch targets ≥ 44px
Every `a`, `button`, `[role=button]`, `summary` and `label` that is an action gets
`min-height: 44px` below `--bp-md`; inline links inside prose get `padding-block: 6px` and stay
in flow. `--control-h-xs` (28px) is desktop-only.

### Safe-area insets
`viewport-fit=cover` via `export const viewport` in `app/layout.tsx`, then
`padding-bottom: max(var(--space-3), env(safe-area-inset-bottom))` on the savebar and the panel
footer, `bottom: calc(78px + env(safe-area-inset-bottom))` on the jump-to-live pill, and
`padding-inline: max(var(--gutter), env(safe-area-inset-left/right))` on `.samograph-page` for
landscape.

### Type floor
Nothing below **12px** anywhere; nothing below **14px** for content the user reads (utterances,
body prose, field values). `--text-2xs` (11px) is reserved for the tabular line-number gutter
only.

---

## 6. States — one table for the whole system

| state | signal |
|---|---|
| hover | `--hover-surface` background; borders step `--control-border` → `--ink`; `--dur-fast` |
| focus-visible | `outline: 2px solid var(--focus-ring); outline-offset: 2px` — the only focus signal. Inside the dark panel, `--focus-ring: var(--panel-ink)`. |
| active | translate 0, background steps one further toward `--ink`; no scale transforms |
| disabled | `opacity: .45` **and** `--field-bg-disabled` **and** `--line` border **and** `cursor: not-allowed`. Never opacity alone. |
| busy | `aria-busy="true"` → `cursor: progress`, leading 12px spinner, label unchanged (no width jump) |
| error | field: `aria-invalid` → `--crit` border + inline `--text-xs/--crit` message. Page: `.samograph-alert--error` with a `--crit` rail and `--ink` copy. |
| selected / current | `aria-current="page"` in the nav → `--ink` + a 2px `--ink` underline |
| live | mint dot + the word "Live"; motion only, never colour alone; disabled under `prefers-reduced-motion` |

---

## 7. Guard tests every PR must stay green against

| test | what it enforces | implication |
|---|---|---|
| `test/no-dead-css.test.ts` | every `samograph-*` class used in a `.tsx` must have a rule in `globals.css` | define a class before using it |
| `test/css-tokens-defined.test.ts` | every `var(--x)` with no fallback must be defined in the stylesheet | new tokens land in `:root`, not only inside a `@media` block |
| `test/alert-contrast.test.ts` | alert copy clears 4.5:1 on its tint in light and dark | applies to the Alert component work |
| `test/greenroom-tokens.test.ts` | the `--google-btn-*` values, literally | never touch these — Google-mandated |
| `test/transcript-instrument-css.test.ts` | the `.samograph-percall` panel rules | read before any transcript/panel change |
| `test/tokens.test.tsx`, `test/fonts.test.ts` | token registry + font wiring | relevant to breakpoint/gutter and landing convergence work |
