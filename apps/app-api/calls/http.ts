/**
 * HTTP adapter for the `/calls` surface (SPEC §4.1, §5.2, §5.6).
 *
 * `POST /calls {meeting_url}` authenticates the magic-link session cookie,
 * validates the URL, creates a PENDING `calls` row under the caller's tenant,
 * writes an audit-log entry, and enqueues the bot-orchestrator join job. The two
 * read routes (`GET /calls`, `GET /calls/:id`) are authorized through the
 * tenancy gate (`authorizeCall`) and RLS-scoped to the caller's tenant.
 *
 * CRITICAL (defence-in-depth, §5.10): every transaction that touches a
 * tenant-scoped table runs as the NON-superuser `samograph_app` role
 * (`SET LOCAL ROLE`) with `app.tenant_id` set, so RLS — not just app-level
 * filtering — enforces isolation even if the route logic has a bug. A superuser
 * connection would BYPASS RLS and defeat the gate.
 */
import type { SQL } from "bun";
import type { Keyring } from "../../../packages/shared/tokens/signing.ts";
import { setTenant } from "../../../packages/shared/db/client.ts";
import { authorizeCall, type AuthorizeDeps } from "../../../packages/shared/auth/index.ts";
import { verifySession, SESSION_COOKIE_NAME } from "../auth/session.ts";
import type { OrchestratorJob } from "../../bot-orchestrator/index.ts";
import { validateMeetingUrl } from "./validate.ts";
import { errorResponse, CALL_URL_INVALID } from "./errors.ts";

/** Injected collaborators for the `/calls` handler. */
export interface CallsHandlerDeps {
  /** Privileged connection (login role able to `SET ROLE samograph_app`). */
  sql: SQL;
  /** HMAC secret the session cookie was signed with (§5.1). */
  sessionSecret: string;
  /** The bot-orchestrator seam: enqueue a join job for the new call (§5.2). */
  enqueue: (job: OrchestratorJob) => void | Promise<void>;
  /** Token-verification keyring for the gate's share/agent path (out of scope here). */
  keyring?: Keyring;
  /** Epoch-ms clock; defaults to the wall clock. */
  now?: () => number;
}

/**
 * Render a `calls` row for the API. `ingest_secret_hash` (sensitive, §4.2) and
 * `tenant_id` (internal) are deliberately NEVER exposed.
 */
function serializeCall(row: Record<string, unknown>) {
  return {
    id: row.id,
    meeting_url: row.meeting_url,
    status: row.status,
    ingest_degraded: row.ingest_degraded,
    region: row.region,
    recall_bot_id: row.recall_bot_id,
    created_at: row.created_at,
    ended_at: row.ended_at,
    first_line_at: row.first_line_at,
  };
}

/** Unused placeholder when no real keyring is wired (the session path never reads it). */
const PLACEHOLDER_KEYRING: Keyring = Object.freeze({
  current: { kid: "__unused__", secret: "__unused__" },
});

/** Read a named cookie from the request's `Cookie` header. */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/** The single bodyless 401 for an authentication failure (§5.1). */
function unauthenticated(): Response {
  return new Response(null, { status: 401 });
}

/** The single bodyless 403 the tenancy gate renders on DENY (§5.6 / `SAMO-AUTHZ-001`). */
function denied(): Response {
  return new Response(null, { status: 403 });
}

/** Build the Request→Response handler for `/calls` and `/calls/:id`. */
export function createCallsHandler(
  deps: CallsHandlerDeps,
): (req: Request) => Promise<Response> {
  const { sql, sessionSecret, enqueue } = deps;
  const keyring = deps.keyring ?? PLACEHOLDER_KEYRING;

  const gateDeps: AuthorizeDeps = {
    keyring,
    // The session seam: verify the signed cookie (pure HMAC — no DB).
    lookupSession: async (cookie) => {
      const claims = verifySession(cookie, sessionSecret);
      return claims ? { userId: claims.userId, tenantId: claims.tenantId } : null;
    },
    // Privileged pre-tenant call→tenant resolver (only used by the token path,
    // which is out of scope here; kept correct for forward compatibility).
    lookupCallTenant: async (callId) => {
      try {
        const r = await sql`SELECT tenant_id FROM calls WHERE id = ${callId}`;
        return r.length ? (r[0] as { tenant_id: string }).tenant_id : null;
      } catch {
        return null;
      }
    },
    now: deps.now ? Math.floor(deps.now() / 1000) : undefined,
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const cookie = readCookie(req, SESSION_COOKIE_NAME);

    // ── POST /calls — create a call from a meeting URL (§5.2) ─────────────────
    if (req.method === "POST" && url.pathname === "/calls") {
      // 1) Authenticate the owner session. No/invalid session → 401, bodyless.
      const claims = cookie ? verifySession(cookie, sessionSecret) : null;
      if (!claims) return unauthenticated();

      // 2) Validate the URL BEFORE any DB write. Bad URL → typed 400, no row.
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = null;
      }
      const candidate = (body as { meeting_url?: unknown } | null)?.meeting_url;
      const valid = validateMeetingUrl(candidate);
      if (!valid.ok) return errorResponse(CALL_URL_INVALID);

      // 3) Create the PENDING call + audit entry under the tenant, as samograph_app.
      const created = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        await setTenant(tx, claims.tenantId);
        const rows = await tx`
          INSERT INTO calls (tenant_id, meeting_url, status, ingest_degraded)
          VALUES (${claims.tenantId}, ${valid.url}, 'PENDING', false)
          RETURNING id, status`;
        const row = rows[0] as { id: string; status: string };
        await tx`
          INSERT INTO audit_log (tenant_id, call_id, actor, action)
          VALUES (${claims.tenantId}, ${row.id}, ${`user:${claims.userId}`}, 'call.create')`;
        return row;
      });

      // 4) Enqueue the bot-orchestrator join job (§5.2). Return id + status.
      await enqueue({ callId: created.id, meetingUrl: valid.url });
      return Response.json({ id: created.id, status: created.status }, { status: 201 });
    }

    // ── GET /calls — list the caller's tenant's calls (RLS-scoped, §5.10) ─────
    if (req.method === "GET" && url.pathname === "/calls") {
      const claims = cookie ? verifySession(cookie, sessionSecret) : null;
      if (!claims) return unauthenticated();
      const calls = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        await setTenant(tx, claims.tenantId);
        const rows = (await tx`SELECT * FROM calls ORDER BY created_at DESC, id`) as unknown as Record<string, unknown>[];
        return rows.map(serializeCall);
      });
      return Response.json({ calls }, { status: 200 });
    }

    // ── GET /calls/:id — read one call, authorized by the tenancy gate (§5.6) ─
    const match = url.pathname.match(/^\/calls\/([^/]+)$/);
    if (req.method === "GET" && match) {
      const callId = decodeURIComponent(match[1]);
      const result = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        const authz = await authorizeCall(tx as unknown as SQL, { callId, sessionCookie: cookie }, gateDeps);
        if (!authz.authorized) return null;
        // The gate set app.tenant_id; this read is RLS-scoped to that tenant.
        const rows = (await tx`SELECT * FROM calls WHERE id = ${callId}`) as unknown as Record<string, unknown>[];
        return rows.length ? serializeCall(rows[0]) : null;
      });
      if (!result) return denied();
      return Response.json(result, { status: 200 });
    }

    return new Response("not found", { status: 404 });
  };
}
