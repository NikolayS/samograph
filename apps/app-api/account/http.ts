/**
 * HTTP adapter for `DELETE /account` — whole-account GDPR erasure (SPEC §5.14).
 *
 * The owner deletes their ENTIRE tenant. Every call is looped through the SAME
 * #201 per-call cascade the `/calls` surface uses ({@link eraseCallRecording} +
 * {@link purgeCallRows}): a still-LIVE bot is force-left first, its Recall
 * recording deleted, then its `transcripts`/`tokens`/`workers`/`calls` rows are
 * purged. Then the tenant's audit DETAIL is purged and a single
 * `audit_log(action='account_deleted')` tombstone is written — the durable
 * erasure record whose PRESENCE marks the tenant deleted, revoking every
 * stateless session cookie (see {@link tenantActive}). Finally a confirmation
 * email is sent and the caller's own cookie is cleared.
 *
 * CRITICAL (defence-in-depth, §5.10): the destructive DB work runs as the
 * NON-superuser `samograph_app` role (`SET LOCAL ROLE`) with `app.tenant_id` set
 * to the CALLER's tenant, so RLS — not just app logic — CONFINES the erasure to
 * that one tenant. A cross-tenant row is invisible and cannot be touched.
 */
import type { SQL } from "bun";
import { setTenant } from "../../../packages/shared/db/client.ts";
import {
  SESSION_COOKIE_NAME,
  buildClearedSessionCookie,
} from "../auth/session.ts";
import {
  resolveOwnerSession,
  sessionInvalidResponse,
  ACCOUNT_DELETED_ACTION,
} from "../auth/owner-session.ts";
import type { EmailSender } from "../auth/email.ts";
import type { CallRecordingControl } from "../../bot-orchestrator/recallClient.ts";
import { eraseCallRecording, purgeCallRows } from "../calls/erase.ts";

/** Injected collaborators for the `/account` handler. */
export interface AccountHandlerDeps {
  /** Privileged connection (login role able to `SET ROLE samograph_app`). */
  sql: SQL;
  /** HMAC secret the session cookie was signed with (§5.1). */
  sessionSecret: string;
  /** Magic-link + account-deletion email transport (real Resend / dev fake, §5.1). */
  emailSender: EmailSender;
  /**
   * Recall control for the §5.14 erasure: force-leave a still-live bot + erase
   * its recording, per call. Absent ⇒ the DB erasure still happens but the Recall
   * side effects are skipped (real wiring: `getCallRecordingControl`).
   */
  recall?: CallRecordingControl;
  /** Epoch-ms clock; defaults to the wall clock. */
  now?: () => number;
}

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

/** Build the Request→Response handler for `DELETE /account`. */
export function createAccountHandler(
  deps: AccountHandlerDeps,
): (req: Request) => Promise<Response> {
  const { sql, sessionSecret, emailSender } = deps;
  // A no-op default so an unwired handler still performs the DB erasure.
  const recall: CallRecordingControl =
    deps.recall ?? { async leave() {}, async deleteRecording() {} };
  const nowMs = (): number => (deps.now ? deps.now() : Date.now());

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method !== "DELETE" || url.pathname !== "/account") {
      return new Response("not found", { status: 404 });
    }

    // Owner-only. A deleted/erased-tenant cookie → 401 clear-cookie (#114/§5.14);
    // a missing/tampered cookie → bodyless 401.
    const cookie = readCookie(req, SESSION_COOKIE_NAME);
    const session = await resolveOwnerSession(sql, sessionSecret, cookie, nowMs());
    if (session.kind === "stale") return sessionInvalidResponse();
    if (session.kind !== "ok") return new Response(null, { status: 401 });
    const { userId, tenantId } = session.claims;
    const actor = `user:${userId}`;

    // The account owner's email, for the confirmation. Read on the PRIVILEGED
    // connection (`users`/`tenants` carry no samograph_app grant), BEFORE erasure.
    const ownerRows = (await sql`
      SELECT u.email
      FROM users u
      JOIN tenants t ON t.owner_user_id = u.id
      WHERE t.id = ${tenantId}`) as unknown as Array<{ email: string }>;
    const ownerEmail = ownerRows.length ? ownerRows[0].email : null;

    // 1) Gather every call in the tenant (id + bot + status), RLS-scoped.
    const calls = (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, tenantId);
      return (await tx`SELECT id, recall_bot_id, status FROM calls ORDER BY created_at, id`) as unknown as Array<{
        id: string;
        recall_bot_id: string | null;
        status: string;
      }>;
    })) as Array<{ id: string; recall_bot_id: string | null; status: string }>;

    // 2) Recall side-effects per call, OUTSIDE any DB tx (§5.14): a still-LIVE bot
    //    is force-left FIRST, then its recording erased. Sequential so the live-bot
    //    leave is observable while the row still exists (mirrors the per-call route).
    for (const c of calls) {
      await eraseCallRecording(recall, { botId: c.recall_bot_id, status: c.status });
    }

    // 3) Purge every call's rows, then purge the tenant's audit DETAIL and write the
    //    single account_deleted tombstone — ONE RLS-scoped transaction. The tombstone
    //    is the durable erasure record AND the signal that revokes the account's
    //    sessions (tenantActive reads it). Its own call_id stays NULL (account-level).
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, tenantId);
      for (const c of calls) {
        await purgeCallRows(tx as unknown as SQL, c.id);
      }
      await tx`DELETE FROM audit_log WHERE tenant_id = ${tenantId}`;
      await tx`
        INSERT INTO audit_log (tenant_id, actor, action)
        VALUES (${tenantId}, ${actor}, ${ACCOUNT_DELETED_ACTION})`;
    });

    // 4) Confirmation email (§5.14). The erasure has already committed; a transport
    //    failure surfaces typed, never a silent hang.
    if (ownerEmail) await emailSender.sendAccountDeletion({ to: ownerEmail });

    // 5) 200 + clear the caller's cookie (they are signed out on the spot; the dead
    //    cookie now 401s on every route via the #159 deleted-tenant path anyway).
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": buildClearedSessionCookie(),
      },
    });
  };
}
