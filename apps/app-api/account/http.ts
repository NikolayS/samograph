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
 * stateless session cookie (see {@link tenantActive}). The owner's external
 * sign-in identities (`user_identities`, #209) are erased too — a privileged,
 * non-tenant-scoped delete RLS cannot reach and the FK cascade never fires for.
 * Finally a confirmation email is sent and the caller's own cookie is cleared.
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
import { decryptSecret } from "../../../packages/shared/crypto.ts";
import type { GoogleCalendarOAuthPort } from "../calendar/google-calendar-oauth.ts";

/**
 * The address a §5.14-erased account's RETAINED `users` row is left holding
 * (#220). The erasure keeps the row — `tenantActive` reads its tenant's tombstone
 * to revoke every stateless session cookie — but the row must not keep the
 * person's real address, for two reasons that point the same way:
 *
 *  1. **Erasure.** An email is directly-identifying personal data. Retaining it
 *     forever on a row that exists only to say "this account is gone" is exactly
 *     the retention §5.14 promises to end.
 *  2. **Resurrection.** `users.email` is UNIQUE and every sign-in path resolves
 *     by address — `findByEmail` on the Google callback's miss branch, and
 *     `createOrLoadUser`'s upsert on the magic-link one. While the tombstone still
 *     carries the address, the next sign-in ADOPTS the erased account: the Google
 *     path wrote a fresh `user_identities` row (re-creating the provider `sub`
 *     that #218 went to the trouble of deleting) and emailed the erased address
 *     about it, then handed back a session every route 401s. Releasing the address
 *     removes the match, so a returning person is provisioned a genuinely FRESH
 *     user + tenant with no history instead of being silently re-attached to
 *     remnants — or locked out of the product forever by their own tombstone.
 *
 * DETERMINISTIC in the user id, so re-running the erasure is a no-op rather than a
 * UNIQUE violation, and `.invalid` is the RFC 2606 reserved TLD: the result can
 * never be routed, and can never collide with an address a person could own.
 */
export function erasedAccountEmail(userId: string): string {
  return `deleted-${userId}@deleted.invalid`;
}

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
  /** Calendar grant revocation is best effort; local privileged deletion is mandatory. */
  calendarOAuth?: GoogleCalendarOAuthPort;
  /** Versioned keys used to decrypt any retained Calendar refresh token. */
  calendarTokenDecryptionKeys?: Map<number, Buffer>;
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

    // The account owner's id + email, for the confirmation and for the §5.14
    // address release. Read on the PRIVILEGED connection (`users`/`tenants` carry
    // no samograph_app grant), BEFORE erasure — step 4 anonymizes this address, so
    // reading it afterwards would send the confirmation to `@deleted.invalid`.
    // The id comes from `tenants.owner_user_id`, never from the cookie: the row we
    // are about to rewrite must be identified by the DATABASE's idea of who owns
    // this tenant, not by a claim the caller supplied.
    const ownerRows = (await sql`
      SELECT u.id, u.email
      FROM users u
      JOIN tenants t ON t.owner_user_id = u.id
      WHERE t.id = ${tenantId}`) as unknown as Array<{ id: string; email: string }>;
    const ownerEmail = ownerRows.length ? ownerRows[0].email : null;
    const ownerUserId = ownerRows.length ? ownerRows[0].id : null;

    // Load and decrypt credentials on the privileged connection before their
    // local rows are removed. Revocation is an external best-effort side effect;
    // no provider response or credential value is logged or allowed to block
    // the privacy boundary below.
    const calendarRows = ownerUserId === null ? [] : (await sql`
      SELECT id, user_id, tenant_id, encrypted_refresh_token, refresh_token_iv,
             refresh_token_tag, encryption_key_version
      FROM calendar_connections
      WHERE user_id = ${ownerUserId}`) as unknown as Array<{
        id: string; user_id: string; tenant_id: string;
        encrypted_refresh_token: Buffer; refresh_token_iv: Buffer;
        refresh_token_tag: Buffer; encryption_key_version: number;
      }>;
    for (const row of calendarRows) {
      let result: "ok" | "failed" | "skipped" = "skipped";
      try {
        const key = deps.calendarTokenDecryptionKeys?.get(row.encryption_key_version);
        if (deps.calendarOAuth && key) {
          const token = decryptSecret({
            ciphertext: row.encrypted_refresh_token,
            iv: row.refresh_token_iv,
            tag: row.refresh_token_tag,
            keyVersion: row.encryption_key_version,
          }, key, `samo.calendar.refresh.v1|${row.id}|${row.user_id}|${row.tenant_id}`);
          result = await deps.calendarOAuth.revoke(token) ? "ok" : "failed";
        }
      } catch {
        result = "failed";
      }
      console.info(`[calendar/account-erasure] revocation=${result}`);
    }

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

    // 4) Erase the owner's PRE-TENANT personal data. `user_identities` and `users`
    //    are PRIVILEGED tables (migrations 0011 / 0001, ungranted to
    //    samograph_app), so this runs on the privileged connection and
    //    deliberately OUTSIDE the `SET LOCAL ROLE samograph_app` transaction above
    //    — inside it both statements would fail 42501. Neither is covered by the
    //    FK ON DELETE CASCADE either: the erasure writes a tombstone and never
    //    deletes the `users` row, so the cascade never fires.
    //
    //    (a) The external sign-in identities (#209 / S5-1 item 9). A provider
    //        `sub` is personal data that would otherwise survive "erase all my
    //        data". With no RLS to lean on, the DELETE is scoped by the tenant's
    //        own owner.
    //
    //    (b) The owner's ADDRESS (#220). The `users` row is retained on purpose —
    //        `tenantActive` reads its tenant's tombstone to revoke every stateless
    //        session cookie — but retaining the ADDRESS with it left the erasure
    //        both incomplete and REVERSIBLE: `users.email` is UNIQUE and every
    //        sign-in path resolves by address, so the next Google callback's
    //        `findByEmail` HIT re-linked a fresh `user_identities` row to the
    //        erased account and emailed the erased person about it, and the
    //        magic-link path's upsert adopted the same corpse. Releasing the
    //        address removes the match: a returning person is provisioned a
    //        genuinely FRESH user + tenant instead. See `erasedAccountEmail`.
    //
    //    ONE transaction, so an erasure can never come to rest having dropped the
    //    provider `sub` while leaving the address that invites it straight back.
    await sql.begin(async (tx) => {
      await tx`
        DELETE FROM user_identities
        WHERE user_id IN (SELECT owner_user_id FROM tenants WHERE id = ${tenantId})`;
      await tx`
        DELETE FROM calendar_connections
        WHERE user_id IN (SELECT owner_user_id FROM tenants WHERE id = ${tenantId})`;
      if (ownerUserId !== null) {
        await tx`
          UPDATE users SET email = ${erasedAccountEmail(ownerUserId)}
          WHERE id = ${ownerUserId}`;
      }
    });

    // 5) Confirmation email (§5.14). The erasure has already committed; a transport
    //    failure surfaces typed, never a silent hang.
    if (ownerEmail) await emailSender.sendAccountDeletion({ to: ownerEmail });

    // 6) 200 + clear the caller's cookie (they are signed out on the spot; the dead
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
