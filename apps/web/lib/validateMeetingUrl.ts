/**
 * Client-side URL-shape validation for the dashboard "Add samograph to a call"
 * action (SPEC §5.2: "app-api validates (must be a known Zoom / Google Meet URL
 * pattern)"). This is a cheap pre-flight check so the UI rejects obviously
 * wrong input before it ever reaches the (future) `/calls` endpoint; the server
 * remains the source of truth.
 *
 * Pure, dependency-free, DOM-free — typechecked by the repo-wide `tsc --noEmit`.
 */
export type MeetingProvider = "google_meet" | "zoom";

export type MeetingUrlRejectReason =
  | "empty"
  | "invalid_url"
  | "unsupported_host"
  | "missing_meeting_path";

export type MeetingUrlValidation =
  | { ok: true; provider: MeetingProvider; url: string }
  | { ok: false; reason: MeetingUrlRejectReason };

function providerForHost(host: string): MeetingProvider | null {
  if (host === "meet.google.com") return "google_meet";
  if (host === "zoom.us" || host.endsWith(".zoom.us")) return "zoom";
  return null;
}

/**
 * Best-effort provider for an already-validated meeting URL (e.g. a `meeting_url`
 * read back from `GET /calls`). Returns `null` if the host is not recognized.
 * Used by the app-api client to label `Call`s the server returns without a
 * provider field; the URL was provider-validated server-side at creation.
 */
export function meetingProviderForUrl(url: string): MeetingProvider | null {
  try {
    return providerForHost(new URL(url.trim()).hostname.toLowerCase());
  } catch {
    return null;
  }
}

export function validateMeetingUrl(input: string): MeetingUrlValidation {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "invalid_url" };

  const provider = providerForHost(url.hostname.toLowerCase());
  if (provider === null) return { ok: false, reason: "unsupported_host" };

  // A bare host with no meeting path is not a joinable link.
  if (url.pathname === "" || url.pathname === "/") {
    return { ok: false, reason: "missing_meeting_path" };
  }

  return { ok: true, provider, url: trimmed };
}
