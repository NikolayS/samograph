/**
 * Shared request parsing for the ws-hub surfaces (SPEC §5.6, §5.7).
 *
 * Both the `GET /calls/:id/stream` WS upgrade and the `GET /calls/:id/transcript`
 * REST gap-resync endpoint accept the SAME credentials (session cookie → `read`,
 * share token → `share`) and the SAME `?since_seq=N` cursor, then feed them to
 * the one tenancy gate (`authorizeCall`, §5.6). This module is the single place
 * those are lifted off the wire, so the two surfaces stay byte-for-byte aligned.
 */
import { SESSION_COOKIE_NAME } from "../app-api/auth/session.ts";

/** The credentials a call surface authorizes: a session cookie and/or a token. */
export interface CallCredentials {
  sessionCookie: string | null;
  shareToken: string | null;
}

/** Read a named cookie value from a request's `Cookie` header, or null. */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/** Pull a share token from `?token=` or an `Authorization: Bearer …` header. */
export function readShareToken(req: Request, url: URL): string | null {
  const q = url.searchParams.get("token");
  if (q && q.length > 0) return q;
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  return null;
}

/** Lift the session cookie + share token off a request (cookie name defaults). */
export function readCallCredentials(
  req: Request,
  url: URL,
  cookieName: string = SESSION_COOKIE_NAME,
): CallCredentials {
  return {
    sessionCookie: readCookie(req, cookieName),
    shareToken: readShareToken(req, url),
  };
}

/**
 * Whether the `.txt` download should EXCLUDE chat comments (#197). Only the
 * explicit opt-in `?comments=exclude` filters to spoken lines (kind='speech');
 * every other value — including absent — keeps the FULL transcript, so the
 * default download is unchanged. The filter is applied on the `kind` COLUMN by
 * the caller, never by parsing rendered text.
 */
export function parseExcludeComments(url: URL): boolean {
  return url.searchParams.get("comments") === "exclude";
}

/** Parse a non-negative integer `?since_seq`; anything else → `null` (no cursor). */
export function parseSinceSeq(url: URL): number | null {
  const raw = url.searchParams.get("since_seq");
  if (raw === null || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}
