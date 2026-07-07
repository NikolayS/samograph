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
import { sha256Hex } from "../../../packages/shared/crypto.ts";
import type { SQL } from "bun";
import { signToken, type Keyring, type TokenPayload } from "../../../packages/shared/tokens/signing.ts";
import { mintShareToken, revokeToken } from "../../../packages/shared/tokens/store.ts";
import { setTenant } from "../../../packages/shared/db/client.ts";
import { authorizeCall, type AuthorizeDeps } from "../../../packages/shared/auth/index.ts";
import { verifySession, SESSION_COOKIE_NAME } from "../auth/session.ts";
import type { OrchestratorJob } from "../../bot-orchestrator/index.ts";
import { validateMeetingUrl } from "./validate.ts";
import { errorResponse, CALL_URL_INVALID } from "./errors.ts";

/** Default TTL for a minted share token's `expires_at` (§5.7): 30 days. */
const DEFAULT_SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Injected collaborators for the `/calls` handler. */
export interface CallsHandlerDeps {
  /** Privileged connection (login role able to `SET ROLE samograph_app`). */
  sql: SQL;
  /** HMAC secret the session cookie was signed with (§5.1). */
  sessionSecret: string;
  /** The bot-orchestrator seam: enqueue a join job for the new call (§5.2). */
  enqueue: (job: OrchestratorJob) => void | Promise<void>;
  /**
   * Capability-token keyring: the gate's share/agent verify path AND the signer
   * for share tokens minted by `POST /calls/:id/share` (`keyring.current` signs).
   * A real keyring is required for the share routes.
   */
  keyring?: Keyring;
  /** TTL (seconds) for a minted share token's `expires_at`; defaults to 30 days. */
  shareTtlSeconds?: number;
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
    // §5.16 error detail for terminal failures (nullable; sanitized at write time).
    status_reason: row.status_reason,
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

/**
 * The `share` capability credential a request presents (a `?token=` query or an
 * `Authorization: Bearer …` header), or `null`. Owner-only routes use its mere
 * PRESENCE to answer a share-credential attempt with 403 (it must never
 * mint/revoke) while a truly anonymous request gets 401; the read route hands
 * it to the tenancy gate for verification (§5.6/§5.7).
 */
function readShareCredential(req: Request, url: URL): string | null {
  const query = url.searchParams.get("token");
  if (query && query.length > 0) return query;
  const auth = req.headers.get("authorization");
  const m = auth?.trim().match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function hasShareCredential(req: Request, url: URL): boolean {
  return readShareCredential(req, url) !== null;
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
  const shareTtlSeconds = deps.shareTtlSeconds ?? DEFAULT_SHARE_TTL_SECONDS;
  const nowSec = (): number | undefined => (deps.now ? Math.floor(deps.now() / 1000) : undefined);

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

    // ── POST /calls/:id/share — owner mints a `share` capability token (§5.7) ──
    // Owner-only: minting is authorized purely through the SESSION path of the gate
    // (the share scope is NEVER allowed to mint). A request with a share credential
    // but no session → 403; a fully anonymous request → 401.
    const shareMatch = url.pathname.match(/^\/calls\/([^/]+)\/share$/);
    if (req.method === "POST" && shareMatch) {
      const callId = decodeURIComponent(shareMatch[1]);
      const claims = cookie ? verifySession(cookie, sessionSecret) : null;
      if (!claims) return hasShareCredential(req, url) ? denied() : unauthenticated();

      const minted = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        // Session path of the gate; a cross-tenant call_id falls through to DENY.
        const authz = await authorizeCall(tx as unknown as SQL, { callId, sessionCookie: cookie }, gateDeps);
        if (!authz.authorized || !authz.scopes.includes("read")) return null;
        // Mint under the call's tenant (RLS-scoped insert) + audit (token id, not secret).
        const m = await mintShareToken(tx as unknown as SQL, {
          callId,
          signingKey: keyring.current,
          ttlSeconds: shareTtlSeconds,
          now: nowSec(),
        });
        await tx`
          INSERT INTO audit_log (tenant_id, call_id, actor, action, payload_sha256)
          VALUES (${authz.tenantId}, ${callId}, ${`user:${claims.userId}`}, 'share.mint', ${sha256Hex(m.jti)})`;
        return m;
      });
      if (!minted) return denied();
      return Response.json(
        { token: minted.token, token_id: minted.jti, url: `/c/${minted.token}` },
        { status: 201 },
      );
    }

    // Revoke EVERY live share token of a call (rotate + the callId-only DELETE).
    // Audits one `share.revoke` row per flipped jti (hash of the id, never the
    // secret) — an already-revoked/absent link flips nothing, keeping both
    // callers idempotent. Runs inside the caller's authorized transaction.
    const revokeActiveShares = async (
      tx: SQL,
      callId: string,
      tenantId: string,
      actor: string,
    ): Promise<number> => {
      const revokedAt = new Date((nowSec() ?? Math.floor(Date.now() / 1000)) * 1000);
      const flipped = (await tx`
        UPDATE tokens
        SET revoked_at = ${revokedAt}
        WHERE call_id = ${callId} AND revoked_at IS NULL
        RETURNING jti`) as unknown as Array<{ jti: string }>;
      for (const { jti } of flipped) {
        await tx`
          INSERT INTO audit_log (tenant_id, call_id, actor, action, payload_sha256)
          VALUES (${tenantId}, ${callId}, ${actor}, 'share.revoke', ${sha256Hex(jti)})`;
      }
      return flipped.length;
    };

    // ── GET /calls/:id/share — the owner's active share link, or 404 (§5.7) ────
    // Owner-only, like mint. The `tokens` table stores no token SECRET (only the
    // jti/kid/scopes/expiry), so the link is RE-DERIVED: the same persisted jti
    // is re-signed with the current key. Any validly-signed body naming that jti
    // verifies against the same row, so the re-derived URL and the originally
    // minted one are the SAME capability — one revoke kills both.
    if (req.method === "GET" && shareMatch) {
      const callId = decodeURIComponent(shareMatch[1]);
      const claims = cookie ? verifySession(cookie, sessionSecret) : null;
      if (!claims) return hasShareCredential(req, url) ? denied() : unauthenticated();

      const found = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        const authz = await authorizeCall(tx as unknown as SQL, { callId, sessionCookie: cookie }, gateDeps);
        if (!authz.authorized || !authz.scopes.includes("read")) return { denied: true as const };
        const rows = (await tx`
          SELECT jti, scopes, expires_at
          FROM tokens
          WHERE call_id = ${callId} AND revoked_at IS NULL AND expires_at > now()
          ORDER BY expires_at DESC, jti
          LIMIT 1`) as unknown as Array<{ jti: string; scopes: string[]; expires_at: Date | string }>;
        return { denied: false as const, row: rows[0] ?? null };
      });
      if (found.denied) return denied();
      if (!found.row) return new Response(null, { status: 404 });

      const now = nowSec() ?? Math.floor(Date.now() / 1000);
      const payload: TokenPayload = {
        kid: keyring.current.kid,
        call_id: callId,
        scopes: found.row.scopes,
        iat: now,
        exp: Math.floor(new Date(found.row.expires_at).getTime() / 1000),
        jti: found.row.jti,
      };
      const token = signToken(payload, keyring.current);
      return Response.json(
        { token, token_id: found.row.jti, url: `/c/${token}`, active: true },
        { status: 200 },
      );
    }

    // ── POST /calls/:id/share/rotate — new link; the old one stops working (§5.7)
    // Owner-only. One transaction: revoke every live share token (audited per
    // jti), then mint the replacement (audited) — so there is never a window
    // with two live links and never a window with none committed.
    const rotateMatch = url.pathname.match(/^\/calls\/([^/]+)\/share\/rotate$/);
    if (req.method === "POST" && rotateMatch) {
      const callId = decodeURIComponent(rotateMatch[1]);
      const claims = cookie ? verifySession(cookie, sessionSecret) : null;
      if (!claims) return hasShareCredential(req, url) ? denied() : unauthenticated();

      const rotated = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        const authz = await authorizeCall(tx as unknown as SQL, { callId, sessionCookie: cookie }, gateDeps);
        if (!authz.authorized || !authz.scopes.includes("read")) return null;
        const actor = `user:${claims.userId}`;
        await revokeActiveShares(tx as unknown as SQL, callId, authz.tenantId, actor);
        const m = await mintShareToken(tx as unknown as SQL, {
          callId,
          signingKey: keyring.current,
          ttlSeconds: shareTtlSeconds,
          now: nowSec(),
        });
        await tx`
          INSERT INTO audit_log (tenant_id, call_id, actor, action, payload_sha256)
          VALUES (${authz.tenantId}, ${callId}, ${actor}, 'share.mint', ${sha256Hex(m.jti)})`;
        return m;
      });
      if (!rotated) return denied();
      return Response.json(
        { token: rotated.token, token_id: rotated.jti, url: `/c/${rotated.token}` },
        { status: 200 },
      );
    }

    // ── DELETE /calls/:id/share — revoke the call's live share link(s) (§5.7) ──
    // Owner-only; idempotent (nothing live → still 204, no audit row). The ≤ 1 s
    // revoke SLO holds because the verifier is uncached — the very next verify
    // sees `revoked_at`.
    if (req.method === "DELETE" && shareMatch) {
      const callId = decodeURIComponent(shareMatch[1]);
      const claims = cookie ? verifySession(cookie, sessionSecret) : null;
      if (!claims) return hasShareCredential(req, url) ? denied() : unauthenticated();

      const outcome = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        const authz = await authorizeCall(tx as unknown as SQL, { callId, sessionCookie: cookie }, gateDeps);
        if (!authz.authorized || !authz.scopes.includes("read")) return { authorized: false as const };
        await revokeActiveShares(tx as unknown as SQL, callId, authz.tenantId, `user:${claims.userId}`);
        return { authorized: true as const };
      });
      if (!outcome.authorized) return denied();
      return new Response(null, { status: 204 });
    }

    // ── DELETE /calls/:id/share/:tokenId — owner revokes (idempotent; §5.7) ────
    // The ≤ 1 s revoke SLO is satisfied by the no-cache verifier on the WS path —
    // this route introduces NO caching; it only stamps `revoked_at`.
    const revokeMatch = url.pathname.match(/^\/calls\/([^/]+)\/share\/([^/]+)$/);
    if (req.method === "DELETE" && revokeMatch) {
      const callId = decodeURIComponent(revokeMatch[1]);
      const tokenId = decodeURIComponent(revokeMatch[2]);
      const claims = cookie ? verifySession(cookie, sessionSecret) : null;
      if (!claims) return hasShareCredential(req, url) ? denied() : unauthenticated();

      const outcome = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        const authz = await authorizeCall(tx as unknown as SQL, { callId, sessionCookie: cookie }, gateDeps);
        if (!authz.authorized || !authz.scopes.includes("read")) return { authorized: false as const };
        // RLS scopes the revoke to the owner's tenant: a cross-tenant jti is invisible
        // → 0 rows → false (no-op). Audit ONLY a successful flip → idempotent.
        const did = await revokeToken(tx as unknown as SQL, tokenId, { now: nowSec() });
        if (did) {
          await tx`
            INSERT INTO audit_log (tenant_id, call_id, actor, action, payload_sha256)
            VALUES (${authz.tenantId}, ${callId}, ${`user:${claims.userId}`}, 'share.revoke', ${sha256Hex(tokenId)})`;
        }
        return { authorized: true as const };
      });
      if (!outcome.authorized) return denied();
      return new Response(null, { status: 204 });
    }

    // ── GET /calls/:id — read one call, authorized by the tenancy gate (§5.6) ─
    // Two credentials reach this header: the owner's session (`read`) and a
    // share viewer's `?token=` (`share`, §5.7) — the read-only page fetches the
    // status/degraded header through the SAME route. A share grant gets a
    // REDUCED view: never the owner's meeting coordinates or bot internals.
    const match = url.pathname.match(/^\/calls\/([^/]+)$/);
    if (req.method === "GET" && match) {
      const callId = decodeURIComponent(match[1]);
      const shareToken = readShareCredential(req, url);
      const result = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        const authz = await authorizeCall(
          tx as unknown as SQL,
          { callId, sessionCookie: cookie, shareToken },
          gateDeps,
        );
        if (!authz.authorized) return null;
        // The gate set app.tenant_id; this read is RLS-scoped to that tenant.
        const rows = (await tx`SELECT * FROM calls WHERE id = ${callId}`) as unknown as Record<string, unknown>[];
        if (!rows.length) return null;
        const full = serializeCall(rows[0]);
        if (authz.scopes.includes("read")) return full;
        // `share` scope: status header only (id/status/reason/degraded/timeline).
        const { meeting_url: _url, recall_bot_id: _bot, region: _region, ...shared } = full;
        return shared;
      });
      if (!result) return denied();
      return Response.json(result, { status: 200 });
    }

    return new Response("not found", { status: 404 });
  };
}
