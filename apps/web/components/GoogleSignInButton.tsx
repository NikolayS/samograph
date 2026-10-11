/**
 * "Continue with Google" button (issue #209, SPEC.amendments S5-1).
 *
 * A plain LINK, not a `fetch`. `GET /auth/google/start` answers `302` to
 * accounts.google.com, and only a top-level DOCUMENT navigation can follow that
 * — an XHR would either be blocked by CORS or silently follow the redirect and
 * hand us HTML we cannot use. This is also why `apps/web/next.config.mjs` proxies
 * `/auth/google/*` WITHOUT the `sec-fetch-dest: empty` gate its neighbours carry.
 *
 * Google's *Sign in with Google* branding guidelines are a condition of using the
 * mark, so what is honored here is deliberate, not incidental:
 *   - the label is one of Google's APPROVED strings (`Continue with Google`);
 *   - the mark is the unmodified four-colour "G", never recoloured or cropped;
 *   - nothing else goes inside the button;
 *   - 40px minimum height, 4px corner radius, and one of Google's approved
 *     light/dark colour sets (in `globals.css`, so both themes are covered).
 * ONE documented deviation (S5-1 item 11): Google specifies Roboto Medium 14px
 * and we ship `var(--font-body)` at 14px/500, because this app loads no webfont
 * and will not start loading one for a single button.
 *
 * Source: Google Identity — "Sign in with Google" branding guidelines
 * (https://developers.google.com/identity/branding-guidelines).
 */

/** Google's approved label string. Not editorial — do not reword. */
export const GOOGLE_SIGN_IN_LABEL = "Continue with Google";

/** The app-api route that mints state/PKCE and 302s to Google. */
export const GOOGLE_SIGN_IN_HREF = "/auth/google/start";

/**
 * The four Google brand hexes, in the mark's own path order (blue, green,
 * yellow, red).
 *
 * WHY THESE ARE HARD-CODED LITERALS AND MUST NOT BE TOKENISED
 * ----------------------------------------------------------
 * Every other colour in this app goes through a Greenroom `var(--token)` in
 * `apps/web/app/globals.css`, and `test/greenroom-tokens.test.ts` enforces that
 * — but it enforces it by scanning `globals.css` ONLY. These four live here, in
 * TSX, and are outside that scan. That is a DOCUMENTED EXCEPTION (S5-1 item 11),
 * granted by the scan's current scope, NOT by a design decision that TSX colours
 * are fine. If that test ever widens to `.tsx`, these become a build failure —
 * and the correct resolution is to widen the exception, never to replace them
 * with theme tokens.
 *
 * They must not be tokenised because they are not OUR colours to theme: the
 * Google mark is licensed on the condition that it is reproduced unmodified, so
 * it must render identically in light mode, dark mode, and any future palette.
 * A `--google-blue` token is by construction a thing someone can retune per
 * theme, which is exactly the branding violation we need to make impossible.
 * (The button's own chrome — surface, border, label — IS themed, through
 * `--google-btn-*`; those are Google's approved light/dark SETS, and switching
 * between them is required, not forbidden.)
 */
export const GOOGLE_MARK_HEXES = [
  "#4285F4",
  "#34A853",
  "#FBBC05",
  "#EA4335",
] as const;

const [GOOGLE_BLUE, GOOGLE_GREEN, GOOGLE_YELLOW, GOOGLE_RED] = GOOGLE_MARK_HEXES;

/**
 * The official Google "G", unmodified, from Google's supplied SVG asset.
 * Decorative: the adjacent text label already names the action, so exposing the
 * mark to assistive tech would only produce a duplicate announcement.
 */
function GoogleMark() {
  return (
    <svg
      className="samograph-google-mark"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill={GOOGLE_BLUE}
        d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.615z"
      />
      <path
        fill={GOOGLE_GREEN}
        d="M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9087-2.2581c-.8059.54-1.8368.859-3.0477.859-2.344 0-4.3282-1.5831-5.036-3.7104H.9574v2.3318C2.4382 15.9832 5.4818 18 9 18z"
      />
      <path
        fill={GOOGLE_YELLOW}
        d="M3.964 10.71c-.18-.54-.2822-1.1168-.2822-1.71s.1023-1.17.2823-1.71V4.9582H.9573A8.9965 8.9965 0 0 0 0 9c0 1.4523.3477 2.8268.9573 4.0418L3.964 10.71z"
      />
      <path
        fill={GOOGLE_RED}
        d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.426 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.964 7.29C4.6718 5.1627 6.656 3.5795 9 3.5795z"
      />
    </svg>
  );
}

/**
 * Render only when `GET /auth/providers` reports `{google:true}` — the caller
 * (`AuthLanding`) owns that gate. A button that cannot possibly work is worse
 * than no button, which is why branch previews get none.
 */
export function GoogleSignInButton() {
  return (
    <a className="samograph-google-signin" href={GOOGLE_SIGN_IN_HREF}>
      <GoogleMark />
      {GOOGLE_SIGN_IN_LABEL}
    </a>
  );
}
