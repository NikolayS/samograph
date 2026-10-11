/**
 * `GET /calls/:id/transcript?since_seq=N` — the REST gap-resync endpoint
 * (SPEC §5.5, §5.6, §5.10).
 *
 * When the hub overflows it emits a `{type:"gap", since_seq, until_seq}` control
 * frame; the client recovers the dropped range by GETting this endpoint with the
 * gap's lower bound. Authorization goes through the SAME single tenancy gate as
 * the WS upgrade (`authorizeCall`, §5.6) — session cookie → `read`, share token →
 * `share`, no cache — and the read is RLS-scoped to the call's tenant (§5.10):
 *
 *   • `?since_seq=N` → the EXACT missing tail `seq > N`, ascending, no dupes.
 *   • no `?since_seq` → the last ~200 finalized lines (a cold backfill).
 *
 * DENY (no/invalid credential, cross-tenant call, expired/revoked/mis-bound
 * token) → a bodyless 403; a foreign call also returns nothing under RLS even if
 * the gate were bypassed (defence in depth).
 */
import type { SQL } from "bun";
import type { AuthorizeDeps, AuthorizeResult } from "../../packages/shared/auth/index.ts";
import { authorizeCall } from "../../packages/shared/auth/index.ts";
import { SESSION_COOKIE_NAME } from "../app-api/auth/session.ts";
import { renderTranscriptText } from "../../packages/shared/transcript/index.ts";
import {
  parseSinceSeq,
  parseExcludeComments,
  readCallCredentials,
  type CallCredentials,
} from "./request.ts";
import {
  RequestRateCaps,
  shareCapKey,
  readCapKey,
  rateLimitedResponse,
  type CapDecision,
} from "./caps.ts";
import {
  backfillRecent,
  fetchFullTranscript,
  replayTranscripts,
  DEFAULT_BACKFILL_LIMIT,
  type TranscriptLine,
} from "./transcript.ts";

/** Injected collaborators for the transcript REST handler. */
export interface TranscriptHandlerDeps {
  /** Privileged connection able to `SET LOCAL ROLE samograph_app`. */
  sql: SQL;
  /** The tenancy-gate seams (keyring + session/call→tenant lookups). */
  authDeps: AuthorizeDeps;
  /** Session cookie name; defaults to the app-api {@link SESSION_COOKIE_NAME}. */
  sessionCookieName?: string;
  /** Cold-backfill window; defaults to {@link DEFAULT_BACKFILL_LIMIT}. */
  backfillLimit?: number;
  /**
   * Per-token REST request-rate cap (§5.7, §5.16). When present, an authorized
   * read is admitted through {@link RequestRateCaps.tryRequest} keyed EXACTLY like
   * the WS caps — {@link shareCapKey}`(token)` for `share`, {@link readCapKey}`(cookie,
   * callId)` for `read` — so a leaked share link cannot drive unbounded
   * full-transcript reads (the WS surface is capped; this closes the REST hole).
   * Over-cap → 429 `SAMO-RATE-001` + `Retry-After`. Omitted ⇒ no cap (pre-fix behaviour).
   */
  restCaps?: RequestRateCaps;
  /** Epoch-ms clock the request-rate cap reads; defaults to the wall clock. */
  clockMs?: () => number;
}

/** Shape of a successful transcript response body. */
export interface TranscriptResponseBody {
  call_id: string;
  /** Echoes the request cursor (or `null` for a cold backfill). */
  since_seq: number | null;
  lines: TranscriptLine[];
}

/** The single bodyless 403 a denied read renders (§5.6 / `SAMO-AUTHZ-001`). */
function denied(): Response {
  return new Response(null, { status: 403 });
}

/**
 * The three terminal states of the authorize→cap→read pipeline, decided inside
 * the tx so the DB read runs only on GRANT + within-cap: DENY → bodyless 403,
 * over-cap → 429 `SAMO-RATE-001`, GRANT → the read lines.
 */
type ReadOutcome =
  | { kind: "denied" }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "ok"; lines: TranscriptLine[] };

/**
 * Consult the per-token REST request-rate cap for an AUTHORIZED read, keyed
 * exactly like the WS caps (§5.7): the share token for `share`, the (session,
 * call) pair for `read`. Runs only when {@link TranscriptHandlerDeps.restCaps} is
 * configured and the matching credential is present; otherwise admits (a denied
 * request never reaches here, so an invalid credential is not charged). Returns a
 * `CapDecision` — a DENY carries the `Retry-After` back-off.
 */
function checkRestRate(
  deps: TranscriptHandlerDeps,
  authz: Extract<AuthorizeResult, { authorized: true }>,
  credentials: CallCredentials,
): CapDecision {
  const caps = deps.restCaps;
  if (!caps) return { allowed: true, retryAfterMs: 0 };
  const isRead = authz.scopes.includes("read");
  let key: string | null = null;
  if (isRead && credentials.sessionCookie) {
    key = readCapKey(credentials.sessionCookie, authz.callId);
  } else if (!isRead && credentials.shareToken) {
    key = shareCapKey(credentials.shareToken);
  }
  if (key === null) return { allowed: true, retryAfterMs: 0 };
  return caps.tryRequest(key, (deps.clockMs ?? Date.now)());
}

/**
 * Build the `GET /calls/:id/transcript` handler. Returns 404 for non-matching
 * paths/methods so it can be composed under one `Bun.serve` with `/stream`.
 */
export function createTranscriptHandler(
  deps: TranscriptHandlerDeps,
): (req: Request) => Promise<Response> {
  const cookieName = deps.sessionCookieName ?? SESSION_COOKIE_NAME;
  const limit = deps.backfillLimit ?? DEFAULT_BACKFILL_LIMIT;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const match = /^\/calls\/([^/]+)\/transcript$/.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });

    const callId = decodeURIComponent(match[1]);
    const sinceSeq = parseSinceSeq(url);
    const credentials = readCallCredentials(req, url, cookieName);

    // Authorize + read inside ONE tx as the non-super app role: the gate sets
    // app.tenant_id, then the read is RLS-scoped to that tenant (§5.6 / §5.10).
    // The per-token request-rate cap is consulted AFTER authorization (so the
    // scope/key is known) but BEFORE the full-transcript read, so an over-cap
    // share link is rejected without doing the expensive RLS-scoped read (§5.7).
    const outcome = await deps.sql.begin(async (tx): Promise<ReadOutcome> => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      const authz = await authorizeCall(
        tx as unknown as SQL,
        { callId, sessionCookie: credentials.sessionCookie, shareToken: credentials.shareToken },
        deps.authDeps,
      );
      if (!authz.authorized) return { kind: "denied" };
      const rate = checkRestRate(deps, authz, credentials);
      if (!rate.allowed) return { kind: "rate_limited", retryAfterMs: rate.retryAfterMs };
      const lines =
        sinceSeq !== null
          ? await replayTranscripts(tx as unknown as SQL, callId, sinceSeq)
          : await backfillRecent(tx as unknown as SQL, callId, limit);
      return { kind: "ok", lines };
    });

    if (outcome.kind === "denied") return denied();
    if (outcome.kind === "rate_limited") return rateLimitedResponse(outcome.retryAfterMs);
    const body: TranscriptResponseBody = { call_id: callId, since_seq: sinceSeq, lines: outcome.lines };
    return Response.json(body, { status: 200 });
  };
}

/**
 * Build the `GET /calls/:id/transcript.txt` DOWNLOAD handler (Story 3). Returns
 * the call's FULL transcript as plain text, one line per utterance in the
 * CLI-identical `[YYYY-MM-DD HH:MM:SS] Speaker: utterance` framing (byte-
 * identical to the CLI writer / `renderTranscriptText`, SPEC §5.4), with a
 * `Content-Disposition: attachment` filename so the browser saves a file.
 *
 * `?comments=exclude` (#197) filters the download to spoken lines only
 * (`kind='speech'`) via the COLUMN — a "download without chat comments"; any
 * other value (or none) yields the FULL transcript, so the default is unchanged.
 *
 * Authorization goes through the SAME single tenancy gate as the read/stream
 * (`authorizeCall`, §5.6) behind the SAME session/share credentials, and the
 * read is RLS-scoped to the call's tenant. DENY → the same bodyless 403.
 * Returns 404/405 for non-matching paths/methods so it can be composed under
 * one `Bun.serve` alongside `/stream` and `/transcript`.
 */
export function createTranscriptTextHandler(
  deps: TranscriptHandlerDeps,
): (req: Request) => Promise<Response> {
  const cookieName = deps.sessionCookieName ?? SESSION_COOKIE_NAME;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const match = /^\/calls\/([^/]+)\/transcript\.txt$/.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });

    const callId = decodeURIComponent(match[1]);
    const excludeComments = parseExcludeComments(url);
    const credentials = readCallCredentials(req, url, cookieName);

    const outcome = await deps.sql.begin(async (tx): Promise<ReadOutcome> => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      const authz = await authorizeCall(
        tx as unknown as SQL,
        { callId, sessionCookie: credentials.sessionCookie, shareToken: credentials.shareToken },
        deps.authDeps,
      );
      if (!authz.authorized) return { kind: "denied" };
      const rate = checkRestRate(deps, authz, credentials);
      if (!rate.allowed) return { kind: "rate_limited", retryAfterMs: rate.retryAfterMs };
      return {
        kind: "ok",
        lines: await fetchFullTranscript(tx as unknown as SQL, callId, { excludeComments }),
      };
    });

    if (outcome.kind === "denied") return denied();
    if (outcome.kind === "rate_limited") return rateLimitedResponse(outcome.retryAfterMs);
    return new Response(renderTranscriptText(outcome.lines), {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="transcript-${callId}.txt"`,
      },
    });
  };
}
