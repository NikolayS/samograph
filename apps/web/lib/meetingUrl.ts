/**
 * Display-safe presentation of a meeting URL (mobile audit M7 / `d02`).
 *
 * A Zoom join link carries the meeting password in its query string
 * (`?pwd=…`). Rendering the raw URL — as the dashboard used to — puts a join
 * secret on screen, in the DOM, in an `aria-label` and in every screenshot of
 * the page. Every surface that shows a meeting URL goes through these two pure
 * helpers instead:
 *
 *  - {@link meetingTitle} — a readable row/heading title (provider + room id).
 *  - {@link displayMeetingUrl} — scheme + host + path, query AND fragment
 *    stripped, credentials dropped.
 *
 * Neither ever returns the query string, so neither can leak `pwd`. Both are
 * total: an input they cannot parse yields a constant, never an echo of the
 * input (echoing is exactly how a secret would slip through).
 *
 * Pure, dependency-free, DOM-free.
 */

/** `new URL`, retried with an `https://` prefix for a scheme-less paste. */
function parse(input: string): URL | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  for (const candidate of [trimmed, `https://${trimmed}`]) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:") return url;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Zoom writes an 11-digit id as `752 0852 0803`, a 10-digit one as `123 456 7890`. */
function groupZoomId(id: string): string {
  if (id.length === 11) return `${id.slice(0, 3)} ${id.slice(3, 7)} ${id.slice(7)}`;
  if (id.length === 10) return `${id.slice(0, 3)} ${id.slice(3, 6)} ${id.slice(6)}`;
  if (id.length === 9) return `${id.slice(0, 3)} ${id.slice(3, 6)} ${id.slice(6)}`;
  return id;
}

/**
 * A short, human-readable name for a meeting link — `"Google Meet · qpd-zbkg-jfo"`,
 * `"Zoom · 752 0852 0803"` — falling back to the bare host for a link whose room
 * id we cannot identify, and to `"Meeting"` when the input is not a URL at all.
 */
export function meetingTitle(url: string): string {
  const parsed = parse(url);
  if (!parsed) return "Meeting";
  const host = parsed.hostname.toLowerCase();

  if (host === "meet.google.com") {
    // Calendar invites and mail clients often paste the code upper-cased; the
    // room it names is the same room, so normalise rather than fall back.
    const path = parsed.pathname.toLowerCase();
    const code = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})$/.exec(path)?.[1];
    if (code) return `Google Meet · ${code}`;
  }

  if (host === "zoom.us" || host.endsWith(".zoom.us")) {
    // `/j/` join, `/s/` start, `/w/` webinar — all three carry the numeric id.
    const id = /^\/(?:j|s|w)\/(\d{9,11})$/.exec(parsed.pathname)?.[1];
    if (id) return `Zoom · ${groupZoomId(id)}`;
    // A personal meeting room is named by its vanity id instead of a number.
    const vanity = /^\/my\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(parsed.pathname)?.[1];
    if (vanity) return `Zoom · ${vanity}`;
  }

  return host;
}

/**
 * The URL as it may be shown to a human: scheme + host + path only. The query
 * string (Zoom's `?pwd=`), the fragment and any embedded credentials are
 * dropped. Returns `""` for an input that is not a URL — callers render nothing
 * rather than echo raw text that might itself contain a secret.
 */
export function displayMeetingUrl(url: string): string {
  const parsed = parse(url);
  if (!parsed) return "";
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}
