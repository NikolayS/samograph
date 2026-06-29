/**
 * AuthService — orchestrates the two magic-link operations (SPEC §5.1, §6.2 #6).
 *
 * Every external dependency (email transport, link store, user store, rate
 * limiter, clock, signing keyring) is injected, so the full flow is exercised
 * with in-memory fakes and a manual clock — no network, no real time. The HTTP
 * layer (http.ts) is a thin adapter over these two methods.
 */
import type { AuthErrorCode, AuthUser, Clock } from "./types.ts";
import type { SigningKeyring } from "./keyring.ts";
import type { EmailSender } from "./email.ts";
import type { MagicLinkStore, UserStore } from "./stores.ts";
import type { RateLimiter } from "./rate-limit.ts";

/** Independent magic-link rate limits (SPEC §5.1). */
export const PER_EMAIL_LIMIT = 5;
export const PER_IP_LIMIT = 20;
export const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface AuthServiceDeps {
  keyring: SigningKeyring;
  emailSender: EmailSender;
  linkStore: MagicLinkStore;
  userStore: UserStore;
  rateLimiter: RateLimiter;
  sessionSecret: string;
  clock: Clock;
  /** Origin used to build the callback URL, e.g. "https://samograph.dev". */
  baseUrl: string;
  ttlMs?: number;
  /** Override the jti generator (default: crypto.randomUUID). */
  randomJti?: () => string;
}

export interface RequestMagicLinkInput {
  email: string;
  ip: string;
}

export type RequestMagicLinkResult =
  | { ok: true }
  | { ok: false; code: "SAMO-AUTH-004"; retryAfterSec: number };

export interface CallbackResult {
  ok: boolean;
  status: number;
  errorCode?: AuthErrorCode;
  setCookie?: string;
  user?: AuthUser;
}

export class AuthService {
  constructor(_deps: AuthServiceDeps) {
    throw new Error("not implemented: AuthService");
  }

  /** POST /auth/magic-link: rate-limit, mint+supersede, "send" via EmailSender. */
  async requestMagicLink(_input: RequestMagicLinkInput): Promise<RequestMagicLinkResult> {
    throw new Error("not implemented: requestMagicLink");
  }

  /** GET /auth/callback: verify, consume (single-use), create/load user, set cookie. */
  async callback(_token: string): Promise<CallbackResult> {
    throw new Error("not implemented: callback");
  }
}
