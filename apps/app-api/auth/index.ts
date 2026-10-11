/**
 * `@samograph/app-api` magic-link auth subsystem (SPEC §5.1, §5.16, §6.2 #6).
 *
 * The only v1 auth path: passwordless magic links behind a swappable
 * EmailSender, single-use 15-min HMAC+KID tokens, constant-time verify,
 * supersession, independent per-email/per-IP rate limits, and a signed session
 * cookie. Wire these into a server with {@link createAuthHandler} over an
 * {@link AuthService} constructed from the in-memory fakes (Sprint 1) or the
 * Postgres/real-provider implementations later.
 */
export * from "./types.ts";
export * from "./errors.ts";
export {
  base64url,
  fromBase64url,
  hmacSha256,
  constantTimeEqual,
} from "./crypto.ts";
export { SigningKeyring } from "./keyring.ts";
export {
  MAGIC_LINK_TTL_MS,
  issueMagicLinkToken,
  verifyMagicLinkToken,
  type MagicLinkClaims,
  type VerifyResult,
} from "./token.ts";
export {
  type EmailSender,
  type MagicLinkEmail,
  type AccountDeletionEmail,
  type IdentityLinkedEmail,
  InMemoryEmailSender,
} from "./email.ts";
export {
  ResendEmailSender,
  ResendEmailError,
  emailSenderFromEnv,
  RESEND_EMAILS_URL,
  MAGIC_LINK_SUBJECT,
  IDENTITY_LINKED_SUBJECT,
  type ResendEmailSenderOptions,
} from "./resend-email.ts";
export {
  type MagicLinkStore,
  type UserStore,
  type ConsumeResult,
  InMemoryMagicLinkStore,
  InMemoryUserStore,
} from "./stores.ts";
export { PostgresUserStore } from "./pg-user-store.ts";
export { PostgresMagicLinkStore } from "./pg-magic-link-store.ts";
export {
  type RateLimiter,
  type RateDecision,
  InMemoryRateLimiter,
} from "./rate-limit.ts";
export {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  type SessionClaims,
  signSession,
  verifySession,
  buildSessionCookie,
  buildClearedSessionCookie,
  issueSessionCookie,
} from "./session.ts";
export {
  AuthService,
  PER_EMAIL_LIMIT,
  PER_IP_LIMIT,
  RATE_WINDOW_MS,
  type AuthServiceDeps,
  type RequestMagicLinkInput,
  type RequestMagicLinkResult,
  type CallbackResult,
} from "./service.ts";
export { createAuthHandler, clientIp } from "./http.ts";
export {
  type IdentityProvider,
  type IdentityStore,
  type LinkedIdentity,
  type LinkIdentityInput,
  type UserDirectory,
  InMemoryIdentityStore,
} from "./identities.ts";
export { PostgresIdentityStore } from "./pg-identity-store.ts";
export {
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_MS,
  OAUTH_STATE_PURPOSE,
  DEFAULT_RETURN_TO,
  type OAuthStateClaims,
  signOAuthState,
  verifyOAuthState,
  verifyOAuthStateForCallback,
  buildOAuthStateCookie,
  buildClearedOAuthStateCookie,
  issueOAuthStateCookie,
  readOAuthStateCookie,
  codeChallengeS256,
  validateReturnTo,
} from "./oauth-state.ts";
// Appended (not folded into the crypto block above) to keep this PR's diff off
// the lines sibling #209 PRs also touch.
export { randomToken } from "./crypto.ts";
// Google sign-in (issue #209). Appended at the END so the sibling PRs in that
// series each add their block here without colliding.
export {
  GOOGLE_JWKS_URL,
  GOOGLE_ID_TOKEN_ISSUERS,
  GOOGLE_ID_TOKEN_MAX_BYTES,
  GOOGLE_ID_TOKEN_MAX_SUBJECT_LENGTH,
  ID_TOKEN_CLOCK_SKEW_MS,
  ID_TOKEN_MAX_IAT_AGE_MS,
  JWKS_TIMEOUT_MS,
  JWKS_MAX_BYTES,
  JWKS_MAX_KEYS,
  JWKS_MIN_CACHE_MS,
  JWKS_MAX_CACHE_MS,
  JWKS_REFRESH_COOLDOWN_MS,
  JWKS_FAILURE_RETRY_MS,
  JWKS_MIN_MODULUS_BYTES,
  GoogleJwks,
  verifyGoogleIdToken,
  type GoogleIdentity,
  type GoogleIdTokenRejection,
  type VerifyGoogleIdTokenResult,
  type VerifyGoogleIdTokenOptions,
  type JwksKeySource,
  type GoogleJwksOptions,
} from "./google-id-token.ts";
export {
  IN_MEMORY_AUTHORIZE_URL,
  IN_MEMORY_REDIRECT_URI,
  IN_MEMORY_DEFAULT_IDENTITY,
  InMemoryOAuthProvider,
  type OAuthProvider,
  type OAuthIdentity,
  type AuthorizeParams,
  type ExchangeParams,
  type ExchangeResult,
  type OAuthExchangeRejection,
  type InMemoryOAuthProviderOptions,
} from "./oauth.ts";
export {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_OAUTH_SCOPE,
  GOOGLE_OAUTH_CALLBACK_PATH,
  GOOGLE_TOKEN_TIMEOUT_MS,
  GOOGLE_TOKEN_RESPONSE_MAX_BYTES,
  GOOGLE_REGISTERED_REDIRECT_ORIGINS,
  GoogleOAuthError,
  GoogleOAuthProvider,
  googleOAuthFromEnv,
  googleOAuthIsConfigured,
  googleOAuthRedirectUriOverride,
  type GoogleOAuthProviderOptions,
} from "./google-oauth.ts";
// The Google sign-in ROUTES + composition (issue #209, PR 5 of 7). Appended at
// the END for the same reason the blocks above are: each PR in the series adds
// its own block here without colliding with its siblings.
export {
  GOOGLE_START_LIMIT,
  GOOGLE_CALLBACK_LIMIT,
  GoogleAuthService,
  type GoogleAuthServiceDeps,
  type GoogleStartResult,
  type GoogleCallbackResult,
  type GoogleCallbackInput,
} from "./google-service.ts";
export {
  AUTH_ERROR_REDIRECT_PATH,
  createGoogleAuthHandler,
} from "./google-http.ts";
