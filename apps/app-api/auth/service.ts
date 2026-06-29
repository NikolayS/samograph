/**
 * AuthService — orchestrates the two magic-link operations (SPEC §5.1, §6.2 #6).
 *
 * Every external dependency (email transport, link store, user store, rate
 * limiter, clock, signing keyring) is injected, so the full flow is exercised
 * with in-memory fakes and a manual clock — no network, no real time. The HTTP
 * layer (http.ts) is a thin adapter over these two methods.
 */
import { randomUUID } from "node:crypto";
import type { AuthErrorCode, AuthUser, Clock } from "./types.ts";
import type { SigningKeyring } from "./keyring.ts";
import type { EmailSender } from "./email.ts";
import { normalizeEmail, type MagicLinkStore, type UserStore } from "./stores.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { issueMagicLinkToken, verifyMagicLinkToken } from "./token.ts";
import { issueSessionCookie } from "./session.ts";
import { AUTH_ERRORS } from "./errors.ts";

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

const ceilSec = (ms: number): number => Math.ceil(ms / 1000);

export class AuthService {
  private readonly deps: AuthServiceDeps;
  private readonly randomJti: () => string;

  constructor(deps: AuthServiceDeps) {
    this.deps = deps;
    this.randomJti = deps.randomJti ?? (() => randomUUID());
  }

  /** POST /auth/magic-link: rate-limit, mint+supersede, "send" via EmailSender. */
  async requestMagicLink(input: RequestMagicLinkInput): Promise<RequestMagicLinkResult> {
    const { keyring, rateLimiter, linkStore, emailSender, clock, baseUrl, ttlMs } = this.deps;
    const now = clock();
    const email = normalizeEmail(input.email);

    // Independent limits, evaluated in order — whichever fires first blocks.
    const byEmail = await rateLimiter.hit(`email:${email}`, PER_EMAIL_LIMIT, RATE_WINDOW_MS, now);
    if (!byEmail.allowed) {
      return { ok: false, code: "SAMO-AUTH-004", retryAfterSec: ceilSec(byEmail.retryAfterMs) };
    }
    const byIp = await rateLimiter.hit(`ip:${input.ip}`, PER_IP_LIMIT, RATE_WINDOW_MS, now);
    if (!byIp.allowed) {
      return { ok: false, code: "SAMO-AUTH-004", retryAfterSec: ceilSec(byIp.retryAfterMs) };
    }

    const jti = this.randomJti();
    const { token, claims } = issueMagicLinkToken({ email, keyring, now, jti, ttlMs });
    // Newest supersedes: older outstanding links for this email are invalidated
    // server-side here, at issue time (SPEC §5.1).
    await linkStore.issue({
      jti: claims.jti,
      email: claims.email,
      kid: claims.kid,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      status: "outstanding",
    });

    const link = `${baseUrl}/auth/callback?token=${encodeURIComponent(token)}`;
    await emailSender.sendMagicLink({ to: email, link, token });
    return { ok: true };
  }

  /** GET /auth/callback: verify, consume (single-use), create/load user, set cookie. */
  async callback(token: string): Promise<CallbackResult> {
    const { keyring, linkStore, userStore, sessionSecret, clock } = this.deps;
    const now = clock();

    // 1. Cryptographic verification (constant-time HMAC, KID, TTL).
    const verified = verifyMagicLinkToken(token, { keyring, now });
    if (!verified.ok) return this.fail(verified.code);

    // 2. Single-use / replay / supersession — decided by server-side state.
    const consumed = await linkStore.consume(verified.claims.jti);
    switch (consumed.outcome) {
      case "consumed":
        break;
      case "already_consumed":
        return this.fail("SAMO-AUTH-003"); // replay
      case "superseded":
      case "not_found":
        return this.fail("SAMO-AUTH-001"); // invalidated / unknown link
    }

    // 3. Create or load the user + their 1:1 tenant, then mint the session.
    const user = await userStore.createOrLoadUser(verified.claims.email);
    const setCookie = issueSessionCookie(
      { userId: user.id, tenantId: user.tenantId },
      sessionSecret,
      clock,
    );
    return { ok: true, status: 200, setCookie, user };
  }

  private fail(code: AuthErrorCode): CallbackResult {
    return { ok: false, status: AUTH_ERRORS[code].httpStatus, errorCode: code };
  }
}
