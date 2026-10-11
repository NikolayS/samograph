/**
 * GoogleAuthService — the two legs of "Continue with Google" (issue #209, SPEC
 * amendment S5-1; §5.16 codes 006–010).
 *
 * Shaped like `service.ts`: every dependency (OAuth provider, identity store,
 * user store, email transport, rate limiter, clock) is injected, so the whole
 * flow runs against in-memory fakes with no Google credentials, no network and
 * no database. `google-http.ts` is the thin Request→Response adapter over these
 * two methods, exactly as `http.ts` is over `AuthService`.
 *
 * THE TWO RULES THAT CARRY THE SECURITY WEIGHT (issue #209):
 *
 *  1. **`emailVerified === true` is a precondition for touching ANY store.**
 *     `users.email` is UNIQUE and `createOrLoadUser` upserts on it, so calling it
 *     with an unverified provider-asserted address is a one-line account-takeover
 *     endpoint against every existing magic-link user. The fallback is FAIL, not
 *     "then create a new user" — creating would squat the victim's address before
 *     they ever sign up. This module is the SINGLE enforcement point (the ID-token
 *     verifier and the provider deliberately only REPORT the flag), so there is
 *     exactly one place to audit.
 *  2. **Identity resolves by `(provider, subject)` FIRST, and a hit never
 *     consults email at all.** Email is used only on the miss branch. A
 *     Google-side rename is therefore a no-op rather than a lockout, and a
 *     reassigned corporate address cannot walk its new holder into the previous
 *     holder's tenant.
 *
 * Neither leg ever throws for an expected outcome: both return a typed result
 * carrying an {@link AuthErrorCode}, because every failure has to become a
 * redirect and a `throw` in the middle of that mapping is a case someone misses.
 */
import type { AuthErrorCode, Clock } from "./types.ts";
import type { OAuthProvider } from "./oauth.ts";
import type { IdentityStore } from "./identities.ts";
import type { UserStore } from "./stores.ts";
import type { EmailSender } from "./email.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { randomToken } from "./crypto.ts";
import { issueSessionCookie } from "./session.ts";
import {
  codeChallengeS256,
  issueOAuthStateCookie,
  validateReturnTo,
  verifyOAuthStateForCallback,
} from "./oauth-state.ts";
import { RATE_WINDOW_MS } from "./service.ts";

/**
 * Starts per IP per hour. Same number and window as the magic-link per-IP limit
 * (§5.1), in its OWN bucket: a burst of Google clicks must not eat the budget a
 * user needs to request an email link, and vice versa — Google is never allowed
 * to take the recovery credential down with it.
 */
export const GOOGLE_START_LIMIT = 20;

/**
 * Callbacks per IP per hour, in a bucket of its own again.
 *
 * This one guards the OUTBOUND call to Google's token endpoint, and it is
 * charged only AFTER the state cookie has authenticated — so an attacker with no
 * valid cookie cannot spend it at all, and someone replaying a captured cookie
 * cannot turn our server into a load generator against Google. Separate from the
 * start bucket so a normal sign-in (one start + one callback) costs one slot in
 * each rather than two out of one shared twenty.
 */
export const GOOGLE_CALLBACK_LIMIT = 20;

/**
 * The §5.11 counters this flow feeds (SPEC amendment S5-1 item 7; issue #222).
 *
 * A PORT, exactly like the call-path components' metric ports: `MetricsRegistry`
 * satisfies it structurally (the method names match), and a test can pass a
 * counting fake or nothing at all. Deliberately three separate signals rather
 * than one labelled counter, because they answer three different questions —
 * "did anyone press the button", "how do callbacks end", and the one that has a
 * user-facing obligation behind it: how often we attach a Google account to an
 * ALREADY-EXISTING tenant without asking (S5-1 item 5).
 */
export interface GoogleAuthMetrics {
  /** One accepted `GET /auth/google/start`. */
  incGoogleStart(): void;
  /** One finished callback: `ok`, or the §5.16 error code it failed with. */
  incGoogleCallback(result: string): void;
  /** One SILENT link to an existing account — never a new user, never a return. */
  incIdentityLinked(): void;
}

/** Rate-limit bucket prefixes. Distinct strings ⇒ genuinely distinct budgets. */
const START_BUCKET = "google-start:ip:";
const CALLBACK_BUCKET = "google-callback:ip:";

export interface GoogleAuthServiceDeps {
  /**
   * The composed Google client, or `undefined` when this deployment has no
   * Google credentials — the designed state of every branch preview. `undefined`
   * is the ONLY switch: there is no separate "enabled" flag that could disagree
   * with whether a provider actually exists.
   */
  provider: OAuthProvider | undefined;
  identityStore: IdentityStore;
  userStore: UserStore;
  emailSender: EmailSender;
  rateLimiter: RateLimiter;
  /** HMAC secret for BOTH the state cookie and the session cookie (§5.1, S5-1). */
  sessionSecret: string;
  clock: Clock;
  /** Override the CSPRNG for state/nonce/verifier. Tests only — never in prod. */
  randomValue?: () => string;
  /** Where server-side diagnostics go; defaults to `console`. Never user-visible. */
  logger?: { error: (message: string, fields?: Record<string, unknown>) => void };
  /** §5.11 counters (S5-1 item 7). Absent ⇒ counted nowhere; the flow is unchanged. */
  metrics?: GoogleAuthMetrics;
}

/** What `GET /auth/google/start` produces. `location` is absolute (Google). */
export type GoogleStartResult =
  | { ok: true; location: string; setCookie: string }
  | { ok: false; code: AuthErrorCode };

/**
 * What `GET /auth/google/callback` produces. `location` on success is an
 * ALLOWLISTED INTERNAL PATH (never a URL), so it cannot be an open redirect.
 */
export type GoogleCallbackResult =
  | { ok: true; location: string; setCookie: string }
  | { ok: false; code: AuthErrorCode };

/** The callback's untrusted inputs, already split out of the Request. */
export interface GoogleCallbackInput {
  /** The raw `__Host-samo_oauth` cookie value, or null when absent. */
  stateCookie: string | null;
  /** The callback URL's query parameters, verbatim. */
  params: URLSearchParams;
  /** Caller IP for the callback rate-limit bucket (see `clientIp`). */
  ip: string;
}

export class GoogleAuthService {
  readonly #deps: GoogleAuthServiceDeps;
  readonly #random: () => string;
  readonly #logger: { error: (message: string, fields?: Record<string, unknown>) => void };
  readonly #metrics: GoogleAuthMetrics;

  constructor(deps: GoogleAuthServiceDeps) {
    this.#deps = deps;
    this.#random = deps.randomValue ?? (() => randomToken());
    this.#logger = deps.logger ?? {
      error: (message, fields) => console.error(message, fields ?? {}),
    };
    // A no-op sink rather than an `if` at each call site: a metric that is only
    // emitted "when metrics are wired" is a metric someone forgets to emit.
    this.#metrics = deps.metrics ?? {
      incGoogleStart() {},
      incGoogleCallback() {},
      incIdentityLinked() {},
    };
  }

  /** Is Google sign-in composed on this deployment? Backs `GET /auth/providers`. */
  get configured(): boolean {
    return this.#deps.provider !== undefined;
  }

  /**
   * `GET /auth/google/start` — mint state/nonce/PKCE, stash them in the signed
   * `__Host-samo_oauth` cookie, and send the browser to Google.
   *
   * `returnTo` is narrowed by {@link validateReturnTo} BEFORE it is signed, so
   * the cookie can only ever carry an allowlisted internal path. It is narrowed
   * AGAIN at the callback (defence in depth), because the value that ends up in
   * a `Location` header on a freshly-minted session is the one place an open
   * redirect would be worth the most.
   */
  async start(input: { returnTo: string | null; ip: string }): Promise<GoogleStartResult> {
    const { provider, rateLimiter, sessionSecret, clock } = this.#deps;
    if (provider === undefined) return { ok: false, code: "SAMO-AUTH-010" };

    const now = clock();
    const decision = await rateLimiter.hit(
      `${START_BUCKET}${input.ip}`,
      GOOGLE_START_LIMIT,
      RATE_WINDOW_MS,
      now,
    );
    if (!decision.allowed) return { ok: false, code: "SAMO-AUTH-004" };

    // Counted AFTER the SAMO-AUTH-010 and rate-limit gates: this measures
    // "sign-ins we actually started", not "requests that hit the route", so a
    // flood cannot inflate it past the budget that admits it.
    this.#metrics.incGoogleStart();

    const state = this.#random();
    const nonce = this.#random();
    const codeVerifier = this.#random();

    // The cookie keeps the VERIFIER; Google is sent only its SHA-256 hash. That
    // asymmetry is the whole of PKCE: an attacker who intercepts the redirect
    // (or the authorization code) still cannot complete the exchange.
    const setCookie = issueOAuthStateCookie(
      { state, nonce, codeVerifier, returnTo: validateReturnTo(input.returnTo) },
      sessionSecret,
      clock,
    );
    const location = provider.authorizeUrl({
      state,
      nonce,
      codeChallenge: codeChallengeS256(codeVerifier),
    });
    return { ok: true, location, setCookie };
  }

  /**
   * `GET /auth/google/callback` — the whole sign-in, ordered cheapest-and-
   * most-rejecting first. The ORDER is a security property, not a style choice:
   *
   *  1. Google's own `error` param — the most common non-success outcome (the
   *     user pressed Cancel), and free to detect.
   *  2. The state cookie: HMAC verified BEFORE any parse, then shape, then `v`,
   *     then TTL, then a constant-time compare against the echoed `state`
   *     (all inside {@link verifyOAuthStateForCallback}). Nothing below this line
   *     runs for a request that is not bound to a browser we started a flow for —
   *     in particular we never call Google.
   *  3. The authorization code must be present.
   *  4. The rate-limit charge, now that the caller is authenticated.
   *  5. The token exchange + full local ID-token verification (in the provider).
   *  6. The `email_verified` gate — still BEFORE any store call.
   *  7. Identity resolution, provisioning, and only then the session cookie.
   */
  async callback(input: GoogleCallbackInput): Promise<GoogleCallbackResult> {
    const result = await this.#callback(input);
    // EXACTLY ONE increment per callback, at the single exit — `ok` or the
    // §5.16 code. Counting at each `return` inside the flow below would drift
    // the moment a branch is added.
    this.#metrics.incGoogleCallback(result.ok ? "ok" : result.code);
    return result;
  }

  /** The flow itself; `callback` above wraps it purely to count the outcome. */
  async #callback(input: GoogleCallbackInput): Promise<GoogleCallbackResult> {
    const {
      provider,
      identityStore,
      userStore,
      emailSender,
      rateLimiter,
      sessionSecret,
      clock,
    } = this.#deps;
    if (provider === undefined) return { ok: false, code: "SAMO-AUTH-010" };

    const now = clock();

    // 1. Google reported a failure. `access_denied` is the user cancelling —
    //    an INFO outcome, not an error. Everything else is Google's side failing.
    //    Google's `error` / `error_description` text is deliberately never read
    //    into a message, a URL or a log: its endpoints reflect our own request
    //    parameters back, so quoting it only creates something to leak.
    const providerError = input.params.get("error");
    if (providerError !== null) {
      return {
        ok: false,
        code: providerError === "access_denied" ? "SAMO-AUTH-006" : "SAMO-AUTH-008",
      };
    }

    // 2. The state cookie. A missing cookie and a forged one are the same
    //    answer — distinguishing them tells an attacker which check he tripped.
    const cookie = input.stateCookie;
    if (cookie === null || cookie.length === 0) return { ok: false, code: "SAMO-AUTH-007" };
    const claims = verifyOAuthStateForCallback(
      cookie,
      sessionSecret,
      input.params.get("state"),
      now,
    );
    if (claims === null) return { ok: false, code: "SAMO-AUTH-007" };

    // 3. No code and no error is a protocol violation by whatever sent us here.
    const code = input.params.get("code");
    if (code === null || code.length === 0) return { ok: false, code: "SAMO-AUTH-008" };

    // 4. Charge the callback bucket. Reachable only with an authentic state
    //    cookie, so this cannot be spent by an anonymous flood.
    const decision = await rateLimiter.hit(
      `${CALLBACK_BUCKET}${input.ip}`,
      GOOGLE_CALLBACK_LIMIT,
      RATE_WINDOW_MS,
      now,
    );
    if (!decision.allowed) return { ok: false, code: "SAMO-AUTH-004" };

    // 5. Redeem the code with the cookie's OWN verifier and nonce. The provider
    //    verifies the ID token locally, in full — the direct TLS channel to
    //    Google is never taken as proof.
    const exchanged = await provider.exchange({
      code,
      codeVerifier: claims.codeVerifier,
      expectedNonce: claims.nonce,
      nowMs: now,
    });
    if (!exchanged.ok) {
      // `detail` is fixed text derived from our own control flow — it never
      // carries a provider body, an `error_description`, or a credential.
      this.#logger.error("auth.google.callback: exchange rejected", {
        reason: exchanged.reason,
        detail: exchanged.detail,
      });
      return { ok: false, code: exchanged.code };
    }
    const identity = exchanged.identity;

    // 6. THE GATE (S5-1 item 4). Boolean-strict, read only from the locally
    //    verified ID token, and enforced BEFORE any store call: `false`, absent,
    //    the string "true" and the number 1 all land here. Create nothing, link
    //    nothing, mint no cookie.
    if (identity.emailVerified !== true) return { ok: false, code: "SAMO-AUTH-009" };

    let userId: string;
    let tenantId: string;
    // Set ONLY on the link-to-existing branch, and set to the address ALREADY ON
    // FILE — never to the one this token asserted. The recipient of a "someone
    // attached a Google account to yours" warning must not be chosen by the party
    // the warning is about.
    let notifyExistingUserAt: string | undefined;
    try {
      // 7. `(provider, subject)` FIRST. On a hit we are done: the email on this
      //    token — whatever it now says — is never consulted, which is exactly
      //    what makes a Google-side rename a no-op instead of a lockout.
      const existingIdentity = await identityStore.findByProviderSubject(
        "google",
        identity.subject,
      );
      if (existingIdentity !== undefined) {
        userId = existingIdentity.userId;
        tenantId = existingIdentity.tenantId;
      } else {
        // MISS branch — the only branch where email is used at all. A read-only
        // lookup first, so we can tell "attached to an existing account" (which
        // must notify) from "created a new account" (which must not).
        const existingUser = await userStore.findByEmail(identity.email);
        // `google` is passed only on the CREATE branch, and migration 0012's
        // upsert omits the column on conflict — so an account that already
        // existed keeps the method it was created with (S5-1 item 7).
        const user = existingUser ?? (await userStore.createOrLoadUser(identity.email, "google"));
        // The STORE decides who owns the subject: `link` upserts on
        // `(provider, provider_subject)` and its DO UPDATE omits `user_id`, so
        // two concurrent callbacks converge on one row still owned by the
        // original user, and a re-link attempt is a no-op, not a takeover.
        const record = await identityStore.link({
          provider: "google",
          subject: identity.subject,
          userId: user.id,
          email: identity.email,
        });
        userId = record.userId;
        tenantId = record.tenantId;
        notifyExistingUserAt = existingUser?.email;
      }
    } catch (err) {
      // Pre-tenant path: no tenant context exists yet, so this uses plain
      // console/logger rather than the tenant-scoped structured logger (which
      // fails closed without a tenant_id) — same rule as `AuthService.callback`.
      this.#logger.error("auth.google.callback: identity provisioning failed", {
        subject: identity.subject,
        err,
      });
      return { ok: false, code: "SAMO-AUTH-500" };
    }

    // The silent-link counterweight (S5-1 item 5): exactly one email, on the
    // link-to-existing branch only. BEST-EFFORT — the sign-in has already
    // succeeded and a mail outage must not undo it — but never silently
    // swallowed: a failure is logged.
    if (notifyExistingUserAt !== undefined) {
      // The SAME condition that fires the notification fires the counter: the
      // metric and the email can never disagree about what "silently linked"
      // means. New users and returning signers take neither.
      this.#metrics.incIdentityLinked();
      try {
        await emailSender.sendIdentityLinked({
          to: notifyExistingUserAt,
          provider: "google",
        });
      } catch (err) {
        this.#logger.error("auth.google.callback: link notification email failed", {
          userId,
          err,
        });
      }
    }

    // 8. The SAME cookie the magic-link path mints — one session shape, one mint
    //    site. `returnTo` is re-narrowed here even though `start` already did:
    //    this is the value that goes into a `Location` header on a live session.
    const setCookie = issueSessionCookie({ userId, tenantId }, sessionSecret, clock);
    return { ok: true, location: validateReturnTo(claims.returnTo), setCookie };
  }
}
