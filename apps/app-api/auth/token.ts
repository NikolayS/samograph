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
 * HMAC under the payload's KID and compares it CONSTANT-TIME, then checks `exp`
 * against the injected clock. Single-use / supersession is enforced separately
 * by the server-side store keyed on `jti` (see stores.ts); the token itself is
 * stateless.
 */
import type { AuthErrorCode } from "./types.ts";
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
export function issueMagicLinkToken(_opts: IssueOptions): {
  token: string;
  claims: MagicLinkClaims;
} {
  throw new Error("not implemented: issueMagicLinkToken");
}

/**
 * Verify a magic-link token: structural parse → known KID → constant-time HMAC
 * check → TTL. Returns SAMO-AUTH-001 for tamper/bad-signature/unknown-KID and
 * SAMO-AUTH-002 for an expired-but-otherwise-valid token. Single-use/replay is
 * NOT decided here (that needs the store).
 */
export function verifyMagicLinkToken(
  _token: string,
  _opts: { keyring: SigningKeyring; now: number },
): VerifyResult {
  throw new Error("not implemented: verifyMagicLinkToken");
}
