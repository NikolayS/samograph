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
import type { AuthorizeDeps } from "../../packages/shared/auth/index.ts";
import { authorizeCall } from "../../packages/shared/auth/index.ts";
import { SESSION_COOKIE_NAME } from "../app-api/auth/session.ts";
import { renderTranscriptText } from "../../packages/shared/transcript/index.ts";
import { parseSinceSeq, readCallCredentials } from "./request.ts";
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
    const lines = await deps.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      const authz = await authorizeCall(
        tx as unknown as SQL,
        { callId, sessionCookie: credentials.sessionCookie, shareToken: credentials.shareToken },
        deps.authDeps,
      );
      if (!authz.authorized) return null;
      return sinceSeq !== null
        ? replayTranscripts(tx as unknown as SQL, callId, sinceSeq)
        : backfillRecent(tx as unknown as SQL, callId, limit);
    });

    if (lines === null) return denied();
    const body: TranscriptResponseBody = { call_id: callId, since_seq: sinceSeq, lines };
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
    const credentials = readCallCredentials(req, url, cookieName);

    const lines = await deps.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      const authz = await authorizeCall(
        tx as unknown as SQL,
        { callId, sessionCookie: credentials.sessionCookie, shareToken: credentials.shareToken },
        deps.authDeps,
      );
      if (!authz.authorized) return null;
      return fetchFullTranscript(tx as unknown as SQL, callId);
    });

    if (lines === null) return denied();
    return new Response(renderTranscriptText(lines), {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="transcript-${callId}.txt"`,
      },
    });
  };
}
