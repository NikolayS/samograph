/**
 * The data behind the read-only "Sign-in" block on Settings (SPEC amendment
 * S5-1 item 8, §5.12; issue #223).
 *
 * WHY THIS IS THE ONE PART OF `/settings` THAT DOES **NOT** RUN UNDER RLS
 * ---------------------------------------------------------------------
 * Everything else the settings surface reads is tenant data, and
 * `settings/store.ts` reaches it inside a `SET LOCAL ROLE samograph_app` +
 * `app.tenant_id` transaction so RLS — not app logic — confines it (§5.10).
 * `users` (0001) and `user_identities` (0011) are PRE-TENANT tables: they are
 * deliberately NOT granted to `samograph_app` and carry NO RLS, because the
 * OAuth callback must resolve who is signing in BEFORE any tenant exists. Issued
 * from inside that RLS transaction, the SELECTs below would fail `42501`, not
 * return fewer rows. So this read runs on the PRIVILEGED connection — the same
 * one `PostgresIdentityStore`, `PostgresUserStore` and the §5.14 erasure use,
 * and the same one `/settings`' own `tenantExists` pre-check already uses.
 *
 * That privilege is why the scoping here is load-bearing rather than
 * belt-and-braces: with no RLS behind it, `WHERE user_id = $1` IS the isolation.
 * `userId` comes only from the HMAC-verified session claims — never from a query
 * param, a body, or a header — and the caller has already cleared the `#114`
 * dead-tenant check. `signin.db.test.ts` asserts the cross-user case directly
 * against real Postgres rather than inferring it from the tenancy gate.
 *
 * WHAT IS SERVED, AND WHAT IS DELIBERATELY WITHHELD
 * ------------------------------------------------
 *  - `email` is `users.email`: immutable after creation, the address magic links
 *    are sent to, and the ONLY address this system stands behind (S5-1 items
 *    2-3). It is the caller's own address, on the caller's own settings page.
 *  - `user_identities.email` is NEVER served. It is provider-ASSERTED and
 *    explicitly not authoritative; showing it beside the account email would
 *    present two addresses of unequal standing as if they were peers.
 *  - `provider_subject` is NEVER served. Google's `sub` is the identity key and
 *    is personal data; it buys a reader nothing and a screenshot leaks it
 *    forever.
 *  - `last_login_at` is not served either: the block answers "what can open my
 *    account", not "when was it last used", and the narrower payload is the one
 *    that cannot be regretted.
 */
import type { SQL } from "bun";

/** One linked external identity, as it goes over the wire (snake_case). */
export interface SignInIdentityWire {
  /** Mirrors the 0011 CHECK domain — today always `"google"`. */
  provider: string;
  /** ISO-8601 UTC. `user_identities.created_at` — when the link was made. */
  connected_at: string;
}

/** The `signin` block of `GET /settings`. */
export interface SignInWire {
  /** `users.email` — authoritative and immutable, never the provider-asserted one. */
  email: string;
  /**
   * Linked external identities, oldest first. ALWAYS an array: a magic-link-only
   * account serves `[]`, never `null` and never an absent key, so the UI's
   * "not connected" state is a fact it read rather than a shape it guessed.
   */
  identities: SignInIdentityWire[];
}

interface IdentityRow {
  provider: string;
  created_at: Date | string;
}

/** ISO-8601, whatever the driver hands back for a `timestamptz`. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Read the caller's sign-in facts on the PRIVILEGED connection (see header).
 * `userId` MUST come from verified session claims.
 */
export async function readSignIn(sql: SQL, userId: string): Promise<SignInWire> {
  const users = (await sql`
    SELECT email FROM users WHERE id = ${userId}`) as unknown as Array<{ email: string }>;

  const identities = (await sql`
    SELECT provider, created_at
      FROM user_identities
     WHERE user_id = ${userId}
     ORDER BY created_at ASC, provider ASC`) as unknown as IdentityRow[];

  return {
    // The session cleared `tenantExists`, and `tenants.owner_user_id` is an FK to
    // `users`, so a missing row here is an impossible state — degrade to "" rather
    // than 500 the whole settings page over the sign-in block.
    email: users.length ? users[0]!.email : "",
    identities: identities.map((row) => ({
      provider: row.provider,
      connected_at: toIso(row.created_at),
    })),
  };
}
