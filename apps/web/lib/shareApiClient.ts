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

export function createHttpShareApiClient(_baseUrl = ""): ShareApiClient {
  return {
    async mintShare(_callId) {
      throw new AppApiError("SAMO-STUB", "not implemented", false);
    },
    async rotateShare(_callId) {
      throw new AppApiError("SAMO-STUB", "not implemented", false);
    },
    async revokeShare(_callId) {
      throw new AppApiError("SAMO-STUB", "not implemented", false);
    },
    async getShare(_callId) {
      throw new AppApiError("SAMO-STUB", "not implemented", false);
    },
  };
}
