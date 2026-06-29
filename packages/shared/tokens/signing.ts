/**
 * Capability-token signer/verifier — the PURE crypto core (SPEC §5.7, §4.2).
 *
 * No I/O, no clock of its own (the caller passes `now`), no DB. This module
 * owns the on-the-wire token shape and the persisted-vs-derived scope model:
 *
 *   token   = base64url(body) "." base64url(HMAC-SHA256(secret, base64url(body)))
 *   body    = JSON {kid, call_id, scopes[], iat, exp, jti}   ← KID is IN the payload
 *
 * The HMAC is taken over the *encoded* body string so verification never
 * depends on re-serialising JSON byte-identically. Signature comparison is
 * ALWAYS constant-time (`constantTimeEqual` → node:crypto `timingSafeEqual`).
 * KID rotation: the verifier accepts the current OR previous KID (90-day
 * cadence, 30-day overlap; §5.1). The DB-touching half — persistence, jti
 * uniqueness, revocation — lives in ./store.ts.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** The `act:*` scopes the verifier supports (persisted in v2, unminted in v1). */
export const ACT_SCOPES = ["act:chat", "act:frame", "act:presence", "act:leave"] as const;

/**
 * Scopes that get a persisted `tokens` row: `share` (minted in v1) + the v2
 * `act:*` set. The `read` scope is DERIVED from the owner's session by the
 * tenancy gate (§5.6) and is deliberately ABSENT here — it is never persisted.
 */
export const PERSISTED_SCOPES = ["share", ...ACT_SCOPES] as const;

export type PersistedScope = (typeof PERSISTED_SCOPES)[number];

/** A signing key: its `kid` is embedded in every token it signs. */
export interface SigningKey {
  kid: string;
  secret: string;
}

/**
 * The active key plus (optionally) the previous key still inside its rotation
 * overlap. A token verifies if its embedded `kid` matches either one.
 */
export interface Keyring {
  current: SigningKey;
  previous?: SigningKey;
}

/** The signed JSON body. `iat`/`exp` are epoch SECONDS. */
export interface TokenPayload {
  kid: string;
  call_id: string;
  scopes: string[];
  iat: number;
  exp: number;
  jti: string;
}

/** Why a signature/structure check failed (DB reasons live in ./store.ts). */
export type VerifyFailureReason =
  | "malformed"
  | "unknown_kid"
  | "invalid_signature"
  | "expired"
  | "scope_denied"
  | "revoked"
  | "not_persisted";

export type SignatureVerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: VerifyFailureReason };

export interface VerifyOptions {
  /** Current time in epoch seconds. Defaults to the wall clock. */
  now?: number;
}

/** True for `share` + `act:*`; false for `read` and anything unrecognised. */
export function isPersistedScope(scope: string): scope is PersistedScope {
  return (PERSISTED_SCOPES as readonly string[]).includes(scope);
}

/**
 * Guard the persisted-vs-derived boundary BEFORE any row is written. Throws if
 * the set is empty or names a non-persisted scope (notably `read`, which is
 * session-derived and must never reach the `tokens` table — §5.7, §6.2 #2).
 */
export function assertPersistableScopes(scopes: readonly string[]): void {
  if (scopes.length === 0) {
    throw new Error("a capability token must carry at least one scope");
  }
  for (const scope of scopes) {
    if (!isPersistedScope(scope)) {
      throw new Error(
        `scope "${scope}" is not a persisted capability scope ` +
          `(only ${PERSISTED_SCOPES.join(", ")} are persisted; ` +
          `"read" is session-derived, never stored — §5.7)`,
      );
    }
  }
}

/** Does this granted scope set satisfy a single requested scope? */
export function tokenGrants(scopes: readonly string[], requested: string): boolean {
  return scopes.includes(requested);
}

/**
 * Constant-time string equality. Returns false (rather than throwing) on a
 * length mismatch so the signature comparison stays branch-stable; the real
 * byte comparison goes through node:crypto `timingSafeEqual`. HMAC-SHA256
 * base64url signatures are a fixed 43 chars, so length is not a secret.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function encodeBody(payload: TokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function hmac(encodedBody: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedBody).digest("base64url");
}

function keyForKid(keyring: Keyring, kid: string): SigningKey | undefined {
  if (keyring.current.kid === kid) return keyring.current;
  if (keyring.previous?.kid === kid) return keyring.previous;
  return undefined;
}

/**
 * Sign a payload into a token string. The `kid` is bound to the secret: signing
 * with a `payload.kid` that doesn't match `key.kid` is a programming error.
 */
export function signToken(payload: TokenPayload, key: SigningKey): string {
  if (payload.kid !== key.kid) {
    throw new Error(
      `payload.kid "${payload.kid}" does not match signing key kid "${key.kid}"`,
    );
  }
  const body = encodeBody(payload);
  return `${body}.${hmac(body, key.secret)}`;
}

/**
 * Verify a token's STRUCTURE, SIGNATURE, KID and EXPIRY — the parts that need
 * no DB. Persistence, revocation and scope enforcement layer on top in
 * ./store.ts. Order: malformed → unknown_kid → invalid_signature → expired.
 */
export function verifyTokenSignature(
  token: string,
  keyring: Keyring,
  opts: VerifyOptions = {},
): SignatureVerifyResult {
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  const parts = token.split(".");
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    return { ok: false, reason: "malformed" };
  }
  const [body, providedSig] = parts;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    !payload ||
    typeof payload.kid !== "string" ||
    typeof payload.call_id !== "string" ||
    !Array.isArray(payload.scopes) ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    typeof payload.jti !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }

  const key = keyForKid(keyring, payload.kid);
  if (!key) return { ok: false, reason: "unknown_kid" };

  // ALWAYS constant-time — never short-circuit on the first differing byte.
  if (!constantTimeEqual(providedSig, hmac(body, key.secret))) {
    return { ok: false, reason: "invalid_signature" };
  }

  if (payload.exp <= now) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}
