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
  InMemoryEmailSender,
} from "./email.ts";
export {
  ResendEmailSender,
  ResendEmailError,
  emailSenderFromEnv,
  RESEND_EMAILS_URL,
  MAGIC_LINK_SUBJECT,
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
