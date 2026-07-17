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

    // Two INDEPENDENT limits (per-email 5/hr, per-IP 20/hr). Check BOTH without
    // committing, so a rejection on one never advances the other's counter
    // (issue #63 — cross-limiter perturbation). Only commit both once both pass.
    const emailKey = `email:${email}`;
    const ipKey = `ip:${input.ip}`;
    const emailOk = await rateLimiter.peek(emailKey, PER_EMAIL_LIMIT, RATE_WINDOW_MS, now);
    const ipOk = await rateLimiter.peek(ipKey, PER_IP_LIMIT, RATE_WINDOW_MS, now);
    if (!emailOk || !ipOk) {
      // Derive Retry-After from the limit that tripped. A blocked hit() never
      // consumes a slot (rate-limit.ts: "blocked attempts do NOT consume a
      // slot"), so this read leaves both counters untouched.
      const tripped = !emailOk
        ? await rateLimiter.hit(emailKey, PER_EMAIL_LIMIT, RATE_WINDOW_MS, now)
        : await rateLimiter.hit(ipKey, PER_IP_LIMIT, RATE_WINDOW_MS, now);
      return { ok: false, code: "SAMO-AUTH-004", retryAfterSec: ceilSec(tripped.retryAfterMs) };
    }
    // Both within budget → commit both counters.
    await rateLimiter.hit(emailKey, PER_EMAIL_LIMIT, RATE_WINDOW_MS, now);
    await rateLimiter.hit(ipKey, PER_IP_LIMIT, RATE_WINDOW_MS, now);

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

  /** GET /auth/callback: verify, provision user (BEFORE consume), consume (single-use), set cookie. */
  async callback(token: string): Promise<CallbackResult> {
    const { keyring, linkStore, userStore, sessionSecret, clock } = this.deps;
    const now = clock();

    // 1. Cryptographic verification (constant-time HMAC, KID, TTL). An expired
    //    link short-circuits here as SAMO-AUTH-002 (never provisions).
    const verified = verifyMagicLinkToken(token, { keyring, now });
    if (!verified.ok) return this.fail(verified.code);

    // 2. Provision the user + their 1:1 tenant BEFORE consuming the single-use
    //    link (issue #180). The token cryptographically binds this exact email,
    //    and createOrLoadUser is idempotent, so provisioning first is safe. A
    //    transient provisioning failure (e.g. the pre-tenant `INSERT INTO tenants`
    //    hitting a DB/RLS error) must NOT burn the link: we map it to a retryable
    //    SAMO-AUTH-500 and return WITHOUT consuming, so the link stays OUTSTANDING
    //    and the user can click again once we recover. Never an unhandled throw.
    let user: AuthUser;
    try {
      user = await userStore.createOrLoadUser(verified.claims.email);
    } catch (err) {
      // Pre-tenant path: no tenant context yet, so do NOT use the tenant-scoped
      // structured logger (it fails closed without tenant_id). Plain console.error.
      console.error("auth.callback: user provisioning failed", {
        jti: verified.claims.jti,
        err,
      });
      return this.fail("SAMO-AUTH-500");
    }

    // 3. Single-use / replay / supersession — decided by server-side state. Only
    //    now, after provisioning succeeded, do we CONSUME (burn) the link.
    const consumed = await linkStore.consume(verified.claims.jti);
    switch (consumed.outcome) {
      case "consumed":
        break;
      case "already_consumed":
        return this.fail("SAMO-AUTH-003"); // replay — "already used"
      case "superseded":
        return this.fail("SAMO-AUTH-003"); // a newer link replaced this one — "already used"
      case "not_found":
        return this.fail("SAMO-AUTH-001"); // unknown link — no leak
    }

    // 4. Mint the session cookie.
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
