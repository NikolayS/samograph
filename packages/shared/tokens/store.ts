/**
 * Capability-token STORE — the DB-backed half of the verifier (SPEC §5.7, §4.2).
 *
 * Mints persisted tokens into the `tokens` table, enforces `jti` uniqueness
 * (replay prevention across rotations), revokes by stamping `revoked_at`, and
 * runs the FULL verification path: signature/KID/expiry (./signing.ts) + the
 * DB facts that the signature can't carry — IS this token still persisted, has
 * it been revoked, does it hold the requested scope.
 *
 * v1 mints exactly the `share` scope (`mintShareToken`). `mintToken` is the
 * validated primitive v2 uses for `act:*`; it refuses any non-persisted scope
 * (notably `read`) BEFORE writing a row, so the "read is never persisted"
 * invariant (§6.2 #2) holds at the only write site.
 *
 * No verifier-side cache (§5.5): one DB lookup per verify, so a revoke takes
 * effect on the very next call (the ≤ 1 s revoke SLO, §6.2 #4).
 *
 * RLS note: this module runs whatever queries on the `sql` handle it is given.
 * In production the tenancy gate (#41) establishes `app.tenant_id` first, so
 * RLS scopes these writes/reads to the owning tenant; tests connect as the
 * superuser (which bypasses RLS) exactly like the §5.10 RLS suite.
 */
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import {
  assertPersistableScopes,
  signToken,
  tokenGrants,
  verifyTokenSignature,
  type Keyring,
  type SigningKey,
  type TokenPayload,
  type VerifyFailureReason,
} from "./signing.ts";

export interface MintOptions {
  callId: string;
  scopes: string[];
  signingKey: SigningKey;
  /** Time-to-live in seconds; `exp = iat + ttlSeconds`. */
  ttlSeconds: number;
  /** Issue time in epoch seconds (defaults to now). */
  now?: number;
  /** Override the generated `jti` (tests use this to exercise replay). */
  jti?: string;
}

export interface MintedToken {
  token: string;
  jti: string;
  payload: TokenPayload;
}

export interface FullVerifyOptions {
  /** Require the token to grant this scope, else `scope_denied`. */
  requireScope?: string;
  /** Current time in epoch seconds (defaults to now). */
  now?: number;
}

export type FullVerifyResult =
  | { ok: true; callId: string; scopes: string[]; payload: TokenPayload }
  | { ok: false; reason: VerifyFailureReason };

/** Encode a JS string[] as a Postgres array literal for a `text[]` column. */
function toPgTextArray(values: readonly string[]): string {
  const elems = values.map((v) => `"${v.replace(/(["\\])/g, "\\$1")}"`);
  return `{${elems.join(",")}}`;
}

/**
 * Mint and PERSIST a capability token. Validates the scope set against the
 * persisted-scope allowlist FIRST (so a `read` — or any non-persisted scope —
 * throws before any row is written), then signs and inserts one `tokens` row.
 * The `jti` UNIQUE constraint rejects a replayed jti with SQLSTATE 23505.
 */
export async function mintToken(sql: SQL, opts: MintOptions): Promise<MintedToken> {
  assertPersistableScopes(opts.scopes);

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const exp = now + opts.ttlSeconds;
  const jti = opts.jti ?? randomUUID();
  const payload: TokenPayload = {
    kid: opts.signingKey.kid,
    call_id: opts.callId,
    scopes: opts.scopes,
    iat: now,
    exp,
    jti,
  };

  const token = signToken(payload, opts.signingKey);

  await sql`
    INSERT INTO tokens (call_id, scopes, kid, jti, expires_at)
    VALUES (
      ${opts.callId},
      ${toPgTextArray(opts.scopes)}::text[],
      ${opts.signingKey.kid},
      ${jti},
      ${new Date(exp * 1000)}
    )`;

  return { token, jti, payload };
}

/** v1 convenience: mint the `share` scope (the only scope minted in v1). */
export function mintShareToken(
  sql: SQL,
  opts: Omit<MintOptions, "scopes">,
): Promise<MintedToken> {
  return mintToken(sql, { ...opts, scopes: ["share"] });
}

interface TokenRow {
  call_id: string;
  scopes: string[];
  expires_at: Date | string;
  revoked_at: Date | string | null;
}

/**
 * FULL verify: signature/KID/expiry (no cache), then the DB facts.
 * Order of failure: signature reasons → not_persisted → revoked → expired →
 * scope_denied. Returns the persisted scopes (the server's source of truth).
 */
export async function verifyToken(
  sql: SQL,
  token: string,
  keyring: Keyring,
  opts: FullVerifyOptions = {},
): Promise<FullVerifyResult> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  const sig = verifyTokenSignature(token, keyring, { now });
  if (!sig.ok) return sig;

  const rows = (await sql`
    SELECT call_id, scopes, expires_at, revoked_at
    FROM tokens
    WHERE jti = ${sig.payload.jti}`) as unknown as TokenRow[];

  if (rows.length === 0) return { ok: false, reason: "not_persisted" };
  const row = rows[0];

  if (row.revoked_at !== null) return { ok: false, reason: "revoked" };

  // DB is the source of truth for expiry too (defence in depth — the signature
  // layer already rejected exp <= now above).
  if (new Date(row.expires_at).getTime() / 1000 <= now) {
    return { ok: false, reason: "expired" };
  }

  if (opts.requireScope && !tokenGrants(row.scopes, opts.requireScope)) {
    return { ok: false, reason: "scope_denied" };
  }

  return { ok: true, callId: sig.payload.call_id, scopes: row.scopes, payload: sig.payload };
}

/**
 * Revoke a token by stamping `revoked_at`. Idempotent: returns true only when
 * THIS call flipped a live token to revoked; an unknown or already-revoked jti
 * returns false.
 */
export async function revokeToken(
  sql: SQL,
  jti: string,
  opts: { now?: number } = {},
): Promise<boolean> {
  const revokedAt = new Date((opts.now ?? Math.floor(Date.now() / 1000)) * 1000);
  const rows = (await sql`
    UPDATE tokens
    SET revoked_at = ${revokedAt}
    WHERE jti = ${jti} AND revoked_at IS NULL
    RETURNING jti`) as unknown as Array<{ jti: string }>;
  return rows.length > 0;
}
