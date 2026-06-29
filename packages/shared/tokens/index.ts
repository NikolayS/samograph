/**
 * `@samograph/shared` capability tokens (SPEC §5.7, §4.2, §6.2 #2).
 *
 * Pure signer/verifier (./signing.ts) + the persisted store (./store.ts):
 * HMAC-SHA256 tokens with the KID in the payload, constant-time verification,
 * KID-rotation overlap, `jti`-unique replay prevention, and the persisted-vs-
 * derived scope model (`share`/`act:*` persisted; `read` never stored).
 */
export {
  ACT_SCOPES,
  PERSISTED_SCOPES,
  assertPersistableScopes,
  constantTimeEqual,
  isPersistedScope,
  signToken,
  tokenGrants,
  verifyTokenSignature,
  type Keyring,
  type PersistedScope,
  type SignatureVerifyResult,
  type SigningKey,
  type TokenPayload,
  type VerifyFailureReason,
  type VerifyOptions,
} from "./signing.ts";

export {
  mintShareToken,
  mintToken,
  revokeToken,
  verifyToken,
  type FullVerifyOptions,
  type FullVerifyResult,
  type MintedToken,
  type MintOptions,
} from "./store.ts";
