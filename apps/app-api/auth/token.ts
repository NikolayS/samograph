/**
 * Magic-link token: a one-time, single-use, 15-minute, HMAC+KID-signed bearer
 * value (SPEC §5.1, §6.2 #6).
 *
 * Wire format (JWT-shaped but bespoke — magic links are NOT call-scoped, so they
 * do NOT use the persisted `tokens` table, which is for `share`/`act:*` only):
 *
 *     base64url(payloadJson) "." base64url(hmac)
 *
 * The payload carries `{kid, jti, email, iat, exp}`. Verification recomputes the
 * HMAC over the RECEIVED payload segment (no re-serialization → no
 * canonicalization gap) under the payload's KID and compares it CONSTANT-TIME,
 * then checks `exp` against the injected clock. Single-use / supersession is
 * enforced separately by the server-side store keyed on `jti` (see stores.ts);
 * the token itself is stateless.
 */
import type { AuthErrorCode } from "./types.ts";
import { base64url, fromBase64url, constantTimeEqual } from "./crypto.ts";
import type { SigningKeyring } from "./keyring.ts";

/** Time-to-live for a magic link: 15 minutes (SPEC §5.1). */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

export interface MagicLinkClaims {
  kid: string;
  jti: string;
  email: string;
  iat: number;
  exp: number;
}

export interface IssueOptions {
  email: string;
  keyring: SigningKeyring;
  now: number;
  jti: string;
  ttlMs?: number;
}

export type VerifyResult =
  | { ok: true; claims: MagicLinkClaims }
  | { ok: false; code: AuthErrorCode };

/** Mint a signed magic-link token (signed with the keyring's current KID). */
export function issueMagicLinkToken(opts: IssueOptions): {
  token: string;
  claims: MagicLinkClaims;
} {
  const ttl = opts.ttlMs ?? MAGIC_LINK_TTL_MS;
  const claims: MagicLinkClaims = {
    kid: opts.keyring.currentKid,
    jti: opts.jti,
    email: opts.email,
    iat: opts.now,
    exp: opts.now + ttl,
  };
  const payloadB64 = base64url(JSON.stringify(claims));
  const sig = opts.keyring.sign(payloadB64, claims.kid);
  return { token: `${payloadB64}.${base64url(sig)}`, claims };
}

function parseClaims(payloadB64: string): MagicLinkClaims | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64url(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  if (
    typeof c.kid !== "string" ||
    typeof c.jti !== "string" ||
    typeof c.email !== "string" ||
    typeof c.iat !== "number" ||
    typeof c.exp !== "number"
  ) {
    return null;
  }
  return { kid: c.kid, jti: c.jti, email: c.email, iat: c.iat, exp: c.exp };
}

/**
 * Verify a magic-link token: structural parse → known KID → constant-time HMAC
 * check → TTL. Returns SAMO-AUTH-001 for tamper/bad-signature/unknown-KID and
 * SAMO-AUTH-002 for an expired-but-otherwise-valid token. Single-use/replay is
 * NOT decided here (that needs the store).
 */
export function verifyMagicLinkToken(
  token: string,
  opts: { keyring: SigningKeyring; now: number },
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, code: "SAMO-AUTH-001" };
  const [payloadB64, sigB64] = parts;

  const claims = parseClaims(payloadB64);
  if (!claims) return { ok: false, code: "SAMO-AUTH-001" };

  // Unknown / tampered KID — reject before touching any secret.
  if (!opts.keyring.accepts(claims.kid)) return { ok: false, code: "SAMO-AUTH-001" };

  const expected = opts.keyring.sign(payloadB64, claims.kid);
  const actual = fromBase64url(sigB64);
  if (!constantTimeEqual(expected, actual)) return { ok: false, code: "SAMO-AUTH-001" };

  // Signature is valid → the signed `exp` is trustworthy. exp is exclusive.
  if (opts.now >= claims.exp) return { ok: false, code: "SAMO-AUTH-002" };

  return { ok: true, claims };
}
