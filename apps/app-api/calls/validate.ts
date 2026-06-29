/**
 * Meeting-URL validation for `POST /calls` (SPEC §5.2).
 *
 * app-api accepts ONLY a known Zoom or Google Meet meeting link; anything else
 * is rejected with `SAMO-CALL-URL` before any `calls` row is created. The host
 * is matched exactly (or as a TRUE `*.zoom.us` subdomain) so look-alikes such as
 * `meet.google.com.evil.com` or `evilzoom.us` are rejected, not joined — the bot
 * must never be pointed at an attacker-chosen target.
 */

export type MeetingProvider = "zoom" | "meet";

export type ValidateResult =
  | { ok: true; provider: MeetingProvider; url: string }
  | { ok: false };

const REJECT: ValidateResult = { ok: false };

/** Canonical Google Meet code, e.g. `abc-defg-hij` (3-4-3 lowercase letters). */
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/** A Zoom meeting path: join (`/j/`), web client (`/wc/`), short (`/s/`), personal (`/my/`). */
const ZOOM_PATH = /^\/(j|wc|s|my)\//;

/**
 * Validate a candidate `meeting_url`. Returns the matched provider and the
 * normalized URL string on success, or `{ ok: false }` on any rejection.
 */
export function validateMeetingUrl(raw: unknown): ValidateResult {
  if (typeof raw !== "string") return REJECT;

  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return REJECT;
  }

  // Meeting links are always https — reject http and every other scheme.
  if (u.protocol !== "https:") return REJECT;

  const host = u.hostname.toLowerCase();

  // Google Meet: exact host only (blocks `meet.google.com.evil.com`).
  if (host === "meet.google.com") {
    const code = u.pathname.replace(/^\/+/, "");
    return MEET_CODE.test(code) ? { ok: true, provider: "meet", url: u.toString() } : REJECT;
  }

  // Zoom: the apex host or a TRUE subdomain (the leading dot blocks `evilzoom.us`).
  if (host === "zoom.us" || host.endsWith(".zoom.us")) {
    return ZOOM_PATH.test(u.pathname) ? { ok: true, provider: "zoom", url: u.toString() } : REJECT;
  }

  return REJECT;
}
