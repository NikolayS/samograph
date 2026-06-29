/**
 * @samograph/shared — code shared across samograph.dev apps.
 *
 * The transcript normalizer (§6.2 #1) and capability tokens (§6.2 #2) live
 * here; the tenancy-gate / auth helpers (§6.2 #4) land in their own Sprint-1
 * issue (#41).
 */
export const PACKAGE_NAME = "@samograph/shared";

// Canonical transcript normalizer (#39, SPEC §5.4 / §6.2 #1) — pure, no I/O.
export {
  normalizeTranscriptLine,
  sanitizeTranscriptField,
} from "./transcript/index.ts";

// Capability token generator/verifier (#40, SPEC §5.7 / §6.2 #2). Pure signer
// + the persisted-token store (HMAC-SHA256, KID rotation, jti-unique replay
// prevention, constant-time verify; `share`/`act:*` persisted, `read` never).
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
} from "./tokens/signing.ts";
export {
  mintShareToken,
  mintToken,
  revokeToken,
  verifyToken,
  type FullVerifyOptions,
  type FullVerifyResult,
  type MintedToken,
  type MintOptions,
} from "./tokens/store.ts";
