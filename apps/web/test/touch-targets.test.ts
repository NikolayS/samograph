import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Mobile audit M3 (`scratchpad/ui-audit/MOBILE-AUDIT.md`).
 *
 * Two defects, one guard:
 *
 * 1. **Type floor.** `--text-xs: 0.75rem` (12px) is the smallest size the token
 *    scale admits, but the stylesheet carried eleven raw `.66–.74rem` literals
 *    that resolve to 9.73–11.84px — below the size iOS/Android consider legible
 *    body text. Raw literals are how the floor gets breached, so the floor is
 *    enforced against literals, not against the tokens.
 * 2. **Touch targets.** 24 interactive elements measured under 44 × 44 CSS px
 *    at 390px (`← Dashboard` at 85 × 20, `Reconnect in Settings` at 144 × 17,
 *    every `.samograph-btn` at 36px, `.samograph-btn--sm` at 28px). 44px is the
 *    WCAG 2.2 / iOS HIG minimum.
 *
 * The fix is one media block, so this guard pins the block and its members.
 */
const raw = readFileSync(join(import.meta.dir, "../app/globals.css"), "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

const FLOOR_PX = 12;
const toPx = (value: number, unit: string) => (unit === "px" ? value : value * 16);

/**
 * Rules whose below-floor literal lives in a globals.css region owned by
 * another in-flight mobile-audit PR. Editing them here would collide, so M3
 * reports them in its PR body instead. Each entry MUST name the owning PR.
 *
 * An entry is a (selector, exact value) PAIR, not a selector (#281 review). A
 * selector-only waiver waives the selector forever: drop a new `font-size:
 * .6rem` into an allowlisted rule and the guard says nothing, because the
 * selector — not the breach — was what got excused. Pinning the value means a
 * waiver covers exactly the literal that was measured and nothing else.
 *
 * Entries also rot: once the owning PR lands the fix, the waiver outlives the
 * breach and quietly re-opens the hole for whatever lands under that selector
 * next — so a waiver that matches no measured literal fails the guard until it
 * is deleted ("has no waiver left over for a literal that is already gone").
 * The M1 transcript-row waiver was exactly that, once #280 landed.
 */
const OWNED_ELSEWHERE = new Map<string, string>([
  // Empty on purpose. `.samograph-button`, `.samograph-instrument`,
  // `.samograph-instrument-foot` and `.samograph-site-footer` were fixed by M5
  // (#290) and `.samograph-instrument-lines > li.samograph-transcript-row` by
  // M1 (#280), so every one of those waivers is gone and all five selectors are
  // enforced by this guard like everything else. An entry is a temporary
  // parking space for one in-flight PR, never a permanent exemption — delete it
  // the moment that PR lands, which the staleness case below now forces.
]);

/** The allowlist key for one measured literal: selector AND exact value. */
const waiverKey = (literal: Literal) => `${literal.selector} { font-size: ${literal.value} }`;

type Literal = { selector: string; value: string; px: number };

function belowFloorLiterals(): Literal[] {
  const found: Literal[] = [];
  for (const [, prelude, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    // The prelude of a nested rule is everything since the previous brace,
    // including any `@media` header; the last line of it is the selector.
    const selector = normalize(prelude.split(/[;{}]/).pop() ?? "").replace(/^@media[^{]*/, "");
    for (const [, value, unit] of body.matchAll(/font-size\s*:\s*([0-9.]+)(rem|px|em)/g)) {
      const px = toPx(Number(value), unit);
      if (px < FLOOR_PX) found.push({ selector, value: `${value}${unit}`, px });
    }
  }
  return found;
}

describe("type floor — nothing renders below 12px", () => {
  it("has no raw font-size literal under 0.75rem outside another PR's region", () => {
    const offenders = belowFloorLiterals()
      .filter((literal) => !OWNED_ELSEWHERE.has(waiverKey(literal)))
      .map((literal) => `${waiverKey(literal)} /* ${literal.px}px */`)
      .sort();
    expect(offenders).toEqual([]);
  });

  it("has no waiver left over for a literal that is already gone", () => {
    // A waiver that no longer matches anything in globals.css is a hole waiting
    // for the next literal under that selector. Delete it when its PR lands.
    const measured = new Set(belowFloorLiterals().map(waiverKey));
    const stale = [...OWNED_ELSEWHERE.entries()]
      .filter(([key]) => !measured.has(key))
      .map(([key, owner]) => `${key} — waived for ${owner}, but no such literal exists`)
      .sort();
    expect(stale).toEqual([]);
  });

  it("keeps --text-xs as the 12px floor of the token scale", () => {
    const root = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(normalize(root.match(/--text-xs\s*:\s*([^;]+);/)?.[1] ?? "")).toBe("0.75rem");
  });

  it("sizes the theme switcher from the token scale, not a 10.88px literal", () => {
    const option = normalize(
      css.match(/\.samograph-theme-switcher__option\s*\{([^}]*)\}/)?.[1] ?? "",
    );
    expect(option).toMatch(/font-size\s*:\s*var\(--text-xs\)/);
  });
});

/** The coarse-pointer block, extracted brace-balanced so members can be read. */
function tapBlock(): string {
  const start = css.indexOf("@media (pointer: coarse), (max-width: 767.98px)");
  if (start < 0) return "";
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}" && (depth -= 1) === 0) return css.slice(start, i + 1);
  }
  return "";
}

/**
 * Which `height` an element with these classes ends up with on a phone.
 *
 * jsdom implements no cascade for a stylesheet it never loaded, so this is a
 * deliberately small resolver over the two things that decide a winner here:
 * specificity (class count — every rule that reaches these buttons is a plain
 * class chain) and source order. Rules considered are the unconditional ones
 * plus those inside the coarse-pointer block, which is what a 390px phone
 * matches. Anything more exotic than a class chain is ignored rather than
 * guessed at, so a future selector cannot make this quietly lie.
 */
type Rule = { selectors: string[]; body: string; at: number };

/** Walks braces so a rule nested in an at-rule is read as a rule, not as text. */
function rulesIn(source: string, offset: number, keepAtRule: (prelude: string) => boolean): Rule[] {
  const rules: Rule[] = [];
  let i = 0;
  let preludeStart = 0;
  while (i < source.length) {
    if (source[i] === "}") {
      i += 1;
      preludeStart = i;
      continue;
    }
    if (source[i] !== "{") {
      i += 1;
      continue;
    }
    const prelude = source.slice(preludeStart, i).trim();
    let depth = 0;
    let end = i;
    for (; end < source.length; end += 1) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}" && (depth -= 1) === 0) break;
    }
    const inner = source.slice(i + 1, end);
    if (prelude.startsWith("@")) {
      if (keepAtRule(prelude)) rules.push(...rulesIn(inner, offset + i + 1, keepAtRule));
    } else {
      rules.push({ selectors: prelude.split(","), body: inner, at: offset + preludeStart });
    }
    i = end + 1;
    preludeStart = i;
  }
  return rules;
}

function resolveHeight(classes: string[]): string {
  const owned = new Set(classes);
  let winner = { specificity: -1, order: -1, value: "" };
  // Only the unconditional rules and the coarse-pointer block are in play; any
  // other at-rule may or may not apply on a phone, so it is left out rather
  // than guessed at.
  const rules = rulesIn(css, 0, (prelude) => prelude.includes("(pointer: coarse)"));

  for (const rule of rules) {
    const height = [...rule.body.matchAll(/(?:^|[;\s])height\s*:\s*([^;}]+)/g)].pop()?.[1];
    if (!height) continue;
    for (const raw of rule.selectors) {
      const selector = raw.trim();
      if (!selector || !/^(\.[\w-]+)+$/.test(selector)) continue; // class chains only
      const parts = selector.split(".").filter(Boolean);
      if (!parts.every((name) => owned.has(name))) continue;
      if (parts.length > winner.specificity || (parts.length === winner.specificity && rule.at > winner.order)) {
        winner = { specificity: parts.length, order: rule.at, value: normalize(height) };
      }
    }
  }
  return winner.value;
}

describe("touch targets — 44px on a coarse pointer", () => {
  const block = tapBlock();

  it("defines the tap-target minimum as a token, once", () => {
    const root = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(normalize(root.match(/--tap-min\s*:\s*([^;]+);/)?.[1] ?? "")).toBe("44px");
  });

  it("ships a coarse-pointer block that also covers narrow mouse viewports", () => {
    expect(block).not.toBe("");
  });

  it("lifts every button variant to the tap minimum", () => {
    // The buttons carry a fixed `height` (`--control-h` / `--control-h-sm`).
    // `min-height` clamps it, so the floor holds; `height: auto` is what keeps
    // a label that wraps to two lines at 390px inside its box.
    const btn = normalize(block.match(/\.samograph-btn[^{}]*\{([^}]*)\}/)?.[1] ?? "");
    expect(btn).toMatch(/min-height\s*:\s*var\(--tap-min\)/);
    expect(btn).toMatch(/height\s*:\s*auto/);
    expect(block).toMatch(/\.samograph-btn--sm/);
  });

  it("makes the --sm height override actually win the cascade", () => {
    // Review finding (NON-BLOCKING, PR #281): `.samograph-btn--sm { height:
    // var(--control-h-sm) }` sits AFTER this media block at the same (0,1,0)
    // specificity, so it re-pins 36px and the block's `height: auto` is dead.
    // `min-height` still clamps the box to 44px, which is why nothing looked
    // wrong — but a label that wraps stays boxed against a one-line height.
    // Asserting the declaration is present is not enough; resolve the cascade.
    expect(resolveHeight(["samograph-btn", "samograph-btn--sm"])).toBe("auto");
    expect(resolveHeight(["samograph-btn"])).toBe("auto");
  });

  it("gives the call-view back link and the share-page download a real box", () => {
    for (const selector of [".samograph-call-back", ".samograph-download-transcript"]) {
      expect(block).toContain(selector);
    }
    const back = normalize(
      block.match(/\.samograph-call-back[^{}]*\{([^}]*)\}/)?.[1] ?? "",
    );
    expect(back).toMatch(/min-height\s*:\s*var\(--tap-min\)/);
  });

  it("grows inline prose links with a ::before hit area, not a min-height", () => {
    // An inline `<a>` in a paragraph cannot take `min-height` — it would be
    // ignored on an inline box, and `display: block` would break the sentence.
    // An absolutely-positioned pseudo-element enlarges the hit area in place.
    const hit = normalize(block.match(/a:not\(\[class\]\)::before\s*\{([^}]*)\}/)?.[1] ?? "");
    expect(hit).toMatch(/content\s*:\s*""/);
    expect(hit).toMatch(/position\s*:\s*absolute/);
    expect(hit).toMatch(/height\s*:\s*var\(--tap-min\)/);
    const anchor = normalize(block.match(/a:not\(\[class\]\)\s*\{([^}]*)\}/)?.[1] ?? "");
    expect(anchor).toMatch(/position\s*:\s*relative/);
  });
});
