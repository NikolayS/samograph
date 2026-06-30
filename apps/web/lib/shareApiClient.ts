/**
 * Typed share-link client seam (SPEC §4.1 `/calls/:id/share`, §5.7 `share`
 * scope, Story 2). The per-call page's Share modal talks to app-api only through
 * this interface, so it is testable against an in-memory fake
 * (`fakeShareApiClient.ts`) with no token-service — independent of backend order.
 *
 * A share is a persisted capability token (§5.7): the owner mints it, can rotate
 * it (new token, old stops working) or revoke it (≤ 1 s, Story 2). The read-only
 * page is reached at `/c/<token>`. Failures surface as typed `AppApiError`s
 * carrying the stable `SAMO-…` code (§5.16), never silent.
 *
 * Pure, DOM-free — typechecked by the repo-wide `tsc --noEmit`.
 *
 * STUB: real-impl bodies are placeholders — implemented in the GREEN commit.
 */
import { AppApiError } from "./appApiClient.ts";

// Re-export so callers (and the wire test) get the typed error from one module.
export { AppApiError };

export interface ShareLink {
  /** The opaque share token (the `/c/<token>` path segment). */
  token: string;
  /** The read-only share URL, `/c/<token>`. */
  url: string;
  /** Whether this token is currently active (false ⇒ rotated/revoked). */
  active: boolean;
}

export interface ShareApiClient {
  /** `POST /calls/:id/share` — mint a new read-only share link (§5.7). */
  mintShare(callId: string): Promise<ShareLink>;
  /** `POST /calls/:id/share/rotate` — issue a new token; the old one stops working. */
  rotateShare(callId: string): Promise<ShareLink>;
  /** `DELETE /calls/:id/share` — revoke; the link stops working ≤ 1 s (Story 2). */
  revokeShare(callId: string): Promise<void>;
  /** `GET /calls/:id/share` — the active share link, or `null` if none. */
  getShare(callId: string): Promise<ShareLink | null>;
}

interface ApiErrorBody {
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
}

/** Build the canonical read-only share URL for a token. */
export function shareUrlForToken(token: string): string {
  return `/c/${token}`;
}

async function throwTyped(res: Response, fallbackCode: string): Promise<never> {
  let parsed: ApiErrorBody = {};
  try {
    parsed = (await res.json()) as ApiErrorBody;
  } catch {
    parsed = {};
  }
  const code = typeof parsed.code === "string" ? parsed.code : fallbackCode;
  const message =
    typeof parsed.message === "string" ? parsed.message : "Request failed.";
  const retryable = parsed.retryable === true;
  throw new AppApiError(code, message, retryable, res.status);
}

/** Deserialize a `{ token, url }` server body into a typed, active `ShareLink`. */
function toShareLink(data: { token?: unknown; url?: unknown }): ShareLink {
  const token = typeof data.token === "string" ? data.token : "";
  const url = typeof data.url === "string" ? data.url : shareUrlForToken(token);
  return { token, url, active: true };
}

export function createHttpShareApiClient(baseUrl = ""): ShareApiClient {
  const sharePath = (callId: string) =>
    `${baseUrl}/calls/${encodeURIComponent(callId)}/share`;

  return {
    async mintShare(callId) {
      const res = await fetch(sharePath(callId), {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) await throwTyped(res, "SAMO-AUTHZ-001");
      return toShareLink((await res.json()) as { token?: unknown; url?: unknown });
    },
    async rotateShare(callId) {
      const res = await fetch(`${sharePath(callId)}/rotate`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) await throwTyped(res, "SAMO-AUTHZ-001");
      return toShareLink((await res.json()) as { token?: unknown; url?: unknown });
    },
    async revokeShare(callId) {
      const res = await fetch(sharePath(callId), {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok) await throwTyped(res, "SAMO-AUTHZ-001");
    },
    async getShare(callId) {
      const res = await fetch(sharePath(callId), { credentials: "same-origin" });
      // No active share for this call (revoked or never minted).
      if (res.status === 404) return null;
      if (!res.ok) await throwTyped(res, "SAMO-AUTHZ-001");
      const data = (await res.json()) as {
        token?: unknown;
        url?: unknown;
        active?: unknown;
      };
      return { ...toShareLink(data), active: data.active !== false };
    },
  };
}
