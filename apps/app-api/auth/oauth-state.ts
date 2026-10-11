/**
 * The signed OAuth state cookie + PKCE S256 challenge (issue #209).
 *
 * `GET /auth/google/start` mints a `state`, a `nonce` and a PKCE code verifier,
 * stashes all three in ONE tamper-evident cookie, and sends the browser to
 * Google. `GET /auth/google/callback` gets them back from that cookie and binds
 * the returning authorization code to the browser that started the flow. Without
 * that binding the callback is a login-CSRF endpoint: an attacker runs `/start`
 * himself, plants his own (cookie, state) pair, lures the victim through Google,
 * and the victim is silently signed into the ATTACKER's tenant — where all of
 * the victim's future recordings and notes then land.
 *
 * The wire format is the repo's established
 * `base64url(payloadJson) "." base64url(hmac)` shape ({@link signSession},
 * {@link issueMagicLinkToken}, `packages/shared/tokens/signing.ts`), signed with
 * the SAME `SESSION_SECRET`. Because four payload types now share one key and
 * one shape, the signing input carries a mandatory domain-separation prefix,
 * {@link OAUTH_STATE_PURPOSE} — without it a session cookie and a state cookie
 * would be byte-interchangeable, and a single future refactor that fed one to
 * the other's verifier would become session forgery. The `v1` in the prefix lets
 * the payload format rotate without ever accepting the old one.
 *
 * ORDER IS THE SECURITY PROPERTY in {@link verifyOAuthState}: constant-time HMAC
 * compare FIRST, then a strict shape whitelist, then `v`, then the TTL, then
 * (in {@link verifyOAuthStateForCallback}) the constant-time `state` compare.
 * Attacker-controlled bytes never reach `JSON.parse` before they are
 * authenticated, and no field is reachable without a valid signature.
 */
import { createHash } from "node:crypto";
import type { Clock } from "./types.ts";
import { base64url } from "./crypto.ts";
import { createSealedState } from "./sealed-state.ts";

/**
 * The state cookie name. The `__Host-` prefix is enforced by the browser, not by
 * us: it FORBIDS a `Domain=` attribute and REQUIRES `Secure` + `Path=/`. That is
 * what stops a sibling origin — branch previews all live under `*.samo.cat` —
 * from setting a `Domain=samo.cat` cookie the callback could not distinguish
 * from its own, which is a working state-fixation path. A `__Host-` cookie that
 * is missing `Secure`, or carries `Domain=`, or is scoped to any path other than
 * `/`, is silently DROPPED by the browser, so those three attributes below are
 * load-bearing and must never be "relaxed for dev" (browsers already accept
 * `Secure` cookies on `http://localhost`).
 */
export const OAUTH_STATE_COOKIE_NAME = "__Host-samo_oauth";

/** State cookie lifetime: 10 minutes — one interactive trip through Google. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Domain-separation prefix mixed into the HMAC input. It is what makes a state
 * blob and a session cookie non-interchangeable under the shared
 * `SESSION_SECRET`; see the module header.
 */
export const OAUTH_STATE_PURPOSE = "samo.oauth.state.v1|";

/** Where a sign-in lands when no valid `returnTo` was carried through the flow. */
export const DEFAULT_RETURN_TO = "/dashboard";

/** The claims one in-flight OAuth authorization carries across the round trip. */
export interface OAuthStateClaims {
  /** Payload format version. Exactly `1`; anything else is rejected outright. */
  v: number;
  /** CSPRNG value echoed by Google as `?state=`; binds the callback to this browser. */
  state: string;
  /** CSPRNG value bound into the ID token's `nonce` claim; blocks token replay. */
  nonce: string;
  /** PKCE code verifier (RFC 7636); never leaves the server except as its S256 hash. */
  codeVerifier: string;
  /** Post-sign-in landing path, already narrowed by {@link validateReturnTo}. */
  returnTo: string;
  /** Issue time, epoch MILLISECONDS (same unit as the session cookie's `iat`). */
  iat: number;
}

/** The exact field set a state payload may carry — nothing more, nothing less. */
const STATE_FIELDS = ["v", "state", "nonce", "codeVerifier", "returnTo", "iat"] as const;

const sealedOAuthState = createSealedState<OAuthStateClaims>({
  cookieName: OAUTH_STATE_COOKIE_NAME,
  purpose: OAUTH_STATE_PURPOSE,
  ttlMs: OAUTH_STATE_TTL_MS,
  fields: STATE_FIELDS,
  parseClaims(c) {
    if (typeof c.v !== "number" || typeof c.state !== "string" ||
      typeof c.nonce !== "string" || typeof c.codeVerifier !== "string" ||
      typeof c.returnTo !== "string" || typeof c.iat !== "number") return null;
    return c as unknown as OAuthStateClaims;
  },
});

/** Sign state claims into an opaque, tamper-evident cookie value. */
export function signOAuthState(claims: OAuthStateClaims, secret: string): string {
  return sealedOAuthState.sign(claims, secret);
}

/**
 * Verify + decode a state cookie value, or null if tampered/malformed/expired.
 *
 * The check order is deliberate and is asserted by `oauth-state.test.ts`:
 *
 * 1. **Constant-time HMAC compare** over `OAUTH_STATE_PURPOSE + payload`. Nothing
 *    below this line ever sees unauthenticated bytes — in particular
 *    `JSON.parse` is NOT reached, so a hostile payload cannot exercise the
 *    parser at all, and no field can act as a pre-auth oracle.
 * 2. **Strict shape whitelist** — the parsed object must have EXACTLY
 *    {@link STATE_FIELDS}, each of the right type. An unknown extra field is a
 *    rejection, not something to ignore: a loose cast would let a future field
 *    added by an attacker-influenced path ride along unnoticed.
 * 3. `v === 1`.
 * 4. **TTL**, `now - iat > OAUTH_STATE_TTL_MS`. `>` is strict, matching
 *    {@link verifySession}: exactly-TTL-old is still accepted, one ms older is
 *    not. `now` is epoch MILLISECONDS and defaults to the wall clock, so a call
 *    site that forgets to thread it still ENFORCES the TTL.
 */
export function verifyOAuthState(
  value: string,
  secret: string,
  now: number = Date.now(),
): OAuthStateClaims | null {
  return sealedOAuthState.verify(value, secret, now);
}

/**
 * {@link verifyOAuthState} PLUS the constant-time compare of the `?state=` query
 * parameter Google echoed back. This is the function the callback must call.
 *
 * `stateParam` is a REQUIRED argument, and a missing/empty one is a rejection —
 * never "skip the check when it is absent", which is the same defect class as an
 * OIDC verifier that ignores a missing `nonce`. The compare is constant-time so
 * a forged `state` cannot be recovered byte-by-byte from response timing, and it
 * runs LAST so an unauthenticated cookie never reaches it.
 */
export function verifyOAuthStateForCallback(
  value: string,
  secret: string,
  stateParam: string | null | undefined,
  now: number = Date.now(),
): OAuthStateClaims | null {
  return sealedOAuthState.verifyCallback(value, secret, stateParam, now);
}

/**
 * Build the `Set-Cookie` header value with the fixed security attributes.
 *
 * `Path=/` and `Secure` are mandated by the `__Host-` prefix (see
 * {@link OAUTH_STATE_COOKIE_NAME}); `Domain=` is deliberately absent and must
 * stay absent. `SameSite=Lax` — NOT `Strict` — because the callback arrives as a
 * cross-site top-level GET from `accounts.google.com`, and `Strict` would
 * withhold the cookie on exactly that navigation, breaking 100% of sign-ins.
 */
export function buildOAuthStateCookie(value: string): string {
  return sealedOAuthState.buildCookie(value);
}

/**
 * Build the `Set-Cookie` header value that CLEARS the state cookie: an empty
 * value with `Max-Age=0`, carrying the identical attributes so the clear targets
 * the exact cookie {@link buildOAuthStateCookie} set. Every callback response —
 * success or failure — sends this, so a completed or abandoned flow leaves no
 * live verifier behind.
 */
export function buildClearedOAuthStateCookie(): string {
  return sealedOAuthState.buildClearedCookie();
}

/** Convenience: sign `v:1` claims dated by `clock` and return the Set-Cookie header. */
export function issueOAuthStateCookie(
  claims: Omit<OAuthStateClaims, "v" | "iat">,
  secret: string,
  clock: Clock,
): string {
  return sealedOAuthState.issueCookie(claims, secret, clock);
}

/** Read the state cookie value off a request's `Cookie` header, or null. */
export function readOAuthStateCookie(req: Request): string | null {
  return sealedOAuthState.readCookie(req);
}

/**
 * The PKCE S256 code challenge: `base64url(SHA-256(ASCII(verifier)))`, RFC 7636
 * §4.2. Pinned by the Appendix B known-answer vector in the tests — self
 * consistency is not enough, the value has to be the one GOOGLE recomputes.
 */
export function codeChallengeS256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "utf8").digest());
}

/**
 * The post-sign-in landing targets, as an ENUMERATED allowlist.
 *
 * Not a regex, not a "starts with `/`" check, and not "any path that parses as
 * relative" — every one of those admits at least one of `//evil.com`,
 * `/\evil.com`, `/%2f%2fevil.com` or `https://evil.com`, and an open redirect on
 * this path hands a freshly-minted session to an attacker-chosen origin. Exact
 * string equality against a fixed set cannot be bypassed by encoding tricks
 * because there is no parsing step to trick.
 *
 * Membership rule: a signed-in landing page that carries no capability of its
 * own. `/c/<share-token>` is excluded (the token in the path IS the capability),
 * `/auth` is excluded (bouncing a fresh session back to sign-in is a loop), and
 * `/` is excluded (it is the marketing landing page).
 */
const RETURN_TO_ALLOWLIST: ReadonlySet<string> = new Set([DEFAULT_RETURN_TO, "/settings"]);

/** The one parameterised member: `/calls/<uuid>`. Fully anchored, hex only. */
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Upper bound before any inspection — nothing legitimate is near this long. */
const RETURN_TO_MAX_LEN = 128;

/**
 * Narrow an untrusted `returnTo` to an allowlisted internal path, falling back
 * to {@link DEFAULT_RETURN_TO}. Never throws and never returns the input
 * unmodified unless it is literally an allowlist member: the caller can treat
 * the result as safe to put in a `Location` header verbatim.
 *
 * The `/calls/<uuid>` member is matched by SEGMENT, not by prefix: the value is
 * split on `/` and must be exactly `["", "calls", <uuid>]`. That is why
 * `//calls/<uuid>` (4 segments, empty authority segment) and
 * `/calls/<uuid>?a=1` (the query rides in the id segment and fails
 * {@link UUID_RE}) both fall back.
 */
export function validateReturnTo(value: string | null | undefined): string {
  if (typeof value !== "string") return DEFAULT_RETURN_TO;
  if (value.length === 0 || value.length > RETURN_TO_MAX_LEN) return DEFAULT_RETURN_TO;
  if (RETURN_TO_ALLOWLIST.has(value)) return value;
  const segments = value.split("/");
  if (
    segments.length === 3 &&
    segments[0] === "" &&
    segments[1] === "calls" &&
    UUID_RE.test(segments[2])
  ) {
    return value;
  }
  return DEFAULT_RETURN_TO;
}
