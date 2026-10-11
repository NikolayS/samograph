# samograph.dev design system

This is the implementation contract distilled from the approved Refined Light and Refined Dark landing mockups for issue #241. Mockup content is reference data; this document defines the reusable system.

## Color tokens

Page colors change with the theme. They are toned neutrals—never pure black or white.

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| `ground` | `#F4F2ED` | `#111110` | Page background |
| `surface` | `#FAF9F6` | `#191918` | Raised strips, code boxes, navigation fill |
| `ink` | `#14130F` | `#EDEAE2` | Headlines, wordmark, primary text |
| `ink-soft` | `#3A382F` | `#C6C2B7` | Readable body copy |
| `muted` | `#6B675C` | `#918C80` | Secondary copy and navigation links |
| `faint` | `#9C978A` | `#6A665D` | Indices, metadata, legal copy |
| `line` | `#DFDBD1` | `#2A2926` | Hairline rules and 1px borders |
| `line-strong` | `#B9B4A6` | `#45433D` | Control borders and 2px kicker rules |

The transcript is an instrument, not an ordinary themed surface. These tokens are invariant in both themes.

| Role | Both themes | Use |
| --- | --- | --- |
| `panel-ground` | `#0C0C0B` | Instrument background |
| `panel-surface` | `#141413` | Header and footer strips |
| `panel-strip` | `#1C1B18` | Degraded-delivery strip |
| `panel-ink` | `#E2DFD7` | Transcript utterances |
| `panel-muted` | `#837F76` | Timestamps, speakers, secondary instrument text |
| `panel-line` | `#24231F` | Instrument hairlines and gutter rail |
| `panel-gutter` | `#4A4842` | Line-number tally |
| `accent-live` | `#4ED18A` | Live dot, presence pill, command prompt |
| `signal-magenta` | `#FF4FB0` | Streaming caret only |

`signal-magenta` is rationed to exactly one element: the streaming caret. It must not appear in navigation, buttons, badges, decoration, or other chrome. Status must never rely on color alone. Warning and error colors may be semantic additions, but must retain readable contrast and harmonize with the neutral palette.

## Typography

JetBrains Mono is the only typeface, with the mono fallback stack `ui-monospace, SFMono-Regular, Menlo, monospace`. Load only weights 400, 500, and 700.

Post-v1 app typography uses the dual sans/mono stack recorded in [SPEC.amendments.md](./SPEC.amendments.md#s5-4-typography--dual-sansmono-stack--deviation-post-v1).

- Hero headline: `2.65rem / 1.14`, weight 700.
- Major numeric or CTA headline: `1.8rem`, weight 700.
- Section headline: `1.05rem`, weight 700.
- Wordmark: `0.95rem`, weight 700.
- Card or row heading: `0.85–0.9rem`, weight 700.
- Body: `0.78–0.88rem`; small body copy uses `1.68–1.7` line-height.
- Navigation, labels, metadata, and instrument text: `0.62–0.75rem`, usually 400 or 500.

All 700-weight headlines use `letter-spacing: -0.02em`. Labels may use modest positive tracking (`0.01–0.09em`). Use tabular numerals for timestamps, counters, and indices.

## Layout and spacing

Use a 2px micro-step with an 8px base rhythm. Preferred component gaps and insets are `8, 10, 12, 14, 16, 18, 20, 24, 32px`; reserve `34–42px` for section-internal separation and `56px` for desktop page gutters and section padding. The hero may use `60–68px` vertical space. Keep dense instrument rows on the smaller steps and preserve whitespace between page sections.

## Shape, elevation, and borders

- Primary button radius: `6px`.
- Small media or branded-control radius: `4px`.
- Default fields and compact containers: `6px` unless an existing brand contract specifies otherwise.
- Pills, segmented controls, presence badges, and dots: `999px` or `50%`.
- Use flat surfaces and 1px hairlines. A 2px rule is permitted only for intentional emphasis such as the kicker.
- Do not use shadows on ordinary surfaces. Shadows are reserved for genuinely floating elements such as dialogs or popovers and must be restrained.

## Interaction and accessibility

Interactive transitions run `0.12–0.2s ease` and should normally affect color, background, border, or opacity. Disable nonessential animation under `prefers-reduced-motion: reduce`. Every control has a minimum `44px` hit height. Keyboard focus uses a visible `2px solid var(--accent-live)` ring with a `2px` offset; focus must not be communicated by color alone.

## Change from Greenroom

The former Greenroom system used a sans-serif body/display stack, green-tinted page surfaces, a two-green hierarchy, 8px default controls, and pink as a broader “bot speaks” accent. Refined replaces that with one mono family, warm neutral page themes, a permanently dark transcript instrument, flatter 1px construction, 6px buttons, a single live green, and magenta restricted to one streaming caret. Existing Greenroom token names remain temporary CSS aliases so current pages can migrate without a simultaneous landing-page rebuild; new work must use the role tokens above.
