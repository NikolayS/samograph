/**
 * The OAuth provider PORT for "Continue with Google" (issue #209, SPEC §5.1
 * amendment S5-1), plus its in-memory fake.
 *
 * Shaped like `email.ts`: an interface plus an in-memory implementation, so the
 * service, HTTP and app layers are testable with no Google credentials and no
 * network. The real HTTP adapter lives in `google-oauth.ts`, exactly as
 * `resend-email.ts` sits behind `email.ts`.
 *
 * Two deliberate shape choices:
 *
 *  - {@link ExchangeResult} is a TYPED UNION, never a throw, mirroring
 *    `token.ts`'s `VerifyResult` and `google-id-token.ts`'s
 *    `VerifyGoogleIdTokenResult`. A sign-in callback must map every provider
 *    failure to a redirect, so "throws on failure" would push try/catch into the
 *    one place that must not miss a case.
 *  - {@link InMemoryOAuthProvider} ENFORCES the contract it stands in for. It is
 *    not a yes-machine: it rejects a nonce that does not match the one recorded
 *    at `authorizeUrl` time and an empty `codeVerifier`, so a service that
 *    forgets to thread the nonce or PKCE through fails in EVERY test that uses
 *    the fake, instead of passing everywhere and failing only against Google.
 */

/**
 * A verified identity from an OAuth/OIDC provider. Structurally identical to
 * `google-id-token.ts`'s `GoogleIdentity` — the verifier produces one of these
 * and the provider hands it straight through.
 *
 * `emailVerified` is REPORTED here, never enforced: the service layer is the
 * single enforcement point for the account-takeover gate (issue #209 rule 1), so
 * there is exactly one place to audit.
 */
export interface OAuthIdentity {
  provider: "google";
  subject: string;
  email: string;
  emailVerified: boolean;
}

/** Everything that must be bound into the /authorize redirect. */
export interface AuthorizeParams {
  /** CSRF token, echoed back by the provider and compared to the state cookie. */
  state: string;
  /** Replay defence, minted into the ID token and compared after verification. */
  nonce: string;
  /** base64url(SHA-256(code_verifier)) — the S256 PKCE challenge. */
  codeChallenge: string;
}

/** Everything that must be bound into the token exchange. */
export interface ExchangeParams {
  /** The authorization code the provider handed to the callback. */
  code: string;
  /** The PKCE verifier the state cookie carried. Empty is a caller BUG. */
  codeVerifier: string;
  /** The nonce the state cookie carried; the ID token's must equal it. */
  expectedNonce: string;
  /** Epoch MILLISECONDS. Named for the unit because JWT `exp`/`iat` are seconds. */
  nowMs: number;
}

/**
 * Why an exchange failed. Split by WHOSE fault it is, because the callback maps
 * the two halves to different user-visible copy:
 *
 *  - `unknown_code`, `pkce_missing`, `nonce_mismatch`, `http_error` (4xx),
 *    `malformed_response`, `missing_id_token`, `id_token_rejected`
 *    → the provider refused us or answered nonsense → `SAMO-AUTH-008`;
 *  - `transport_failed`, `response_too_large`, `http_error` (5xx)
 *    → infrastructure → `SAMO-AUTH-500`, retryable.
 */
export type OAuthExchangeRejection =
  | "unknown_code"
  | "pkce_missing"
  | "nonce_mismatch"
  | "transport_failed"
  | "http_error"
  | "response_too_large"
  | "malformed_response"
  | "missing_id_token"
  | "id_token_rejected";

/**
 * The result of a token exchange. Never a throw.
 *
 * `code` is a string LITERAL rather than the `AuthErrorCode` union from
 * `types.ts`: the §5.16 codes 006–010 land with the routes (issue #209 PR 5),
 * and pinning the literal here keeps this module compiling standalone and out of
 * that PR's diff — the same choice `google-id-token.ts` made. Both literals are
 * assignable to the union once it exists.
 *
 * `detail` is a SERVER-SIDE diagnostic for a log line. It is fixed text derived
 * from our own control flow: it never carries a provider response body, a
 * provider `error_description`, or any credential. Nothing in it is ever
 * rendered to a user or put in a URL.
 */
export type ExchangeResult =
  | { ok: true; identity: OAuthIdentity }
  | {
      ok: false;
      code: "SAMO-AUTH-008" | "SAMO-AUTH-500";
      reason: OAuthExchangeRejection;
      detail: string;
    };

/**
 * The seam every OAuth sign-in path is written against. Implemented by
 * `GoogleOAuthProvider` (real HTTP) and {@link InMemoryOAuthProvider} (tests).
 */
export interface OAuthProvider {
  /**
   * The redirect URI registered with the provider, resolved ONCE at
   * construction. The authorize redirect and the token exchange must send the
   * BYTE-IDENTICAL string — Google exact-matches it and rejects the exchange
   * otherwise — so it is a field, not a per-call argument.
   */
  readonly redirectUri: string;
  /** The absolute URL to 302 the browser to. Throws on an empty state/nonce/challenge. */
  authorizeUrl(params: AuthorizeParams): string;
  /** Redeem the code for a VERIFIED identity. Never throws. */
  exchange(params: ExchangeParams): Promise<ExchangeResult>;
}

/** Where the fake's authorize redirect points. `.invalid` can never resolve. */
export const IN_MEMORY_AUTHORIZE_URL = "https://oauth.invalid/o/oauth2/v2/auth";

/** The fake's default redirect URI, in the shape the real one must have. */
export const IN_MEMORY_REDIRECT_URI = "https://oauth.invalid/auth/google/callback";

/** The identity the fake returns unless a test asks `issueCode` for another. */
export const IN_MEMORY_DEFAULT_IDENTITY: OAuthIdentity = {
  provider: "google",
  subject: "117000000000000000001",
  email: "alice@example.com",
  emailVerified: true,
};

export interface InMemoryOAuthProviderOptions {
  /** Override the redirect URI, e.g. to assert an env-derived one flows through. */
  redirectUri?: string;
}

/** What the fake remembers from one `authorizeUrl` call. */
interface RecordedAuthorization {
  state: string;
  nonce: string;
  codeChallenge: string;
}

/** What an issued code is bound to. */
interface IssuedCode {
  nonce: string;
  identity: OAuthIdentity;
}

function fail(
  reason: OAuthExchangeRejection,
  detail: string,
): { ok: false; code: "SAMO-AUTH-008"; reason: OAuthExchangeRejection; detail: string } {
  return { ok: false, code: "SAMO-AUTH-008", reason, detail };
}

/**
 * In-memory OAuthProvider for tests: records what it was asked for and hands
 * back a fixed identity — but ONLY for a request that threaded state, nonce and
 * PKCE through correctly.
 *
 * The enforcement is the entire point. `InMemoryOAuthProvider` drives every
 * downstream service/http/app test, so if it accepted a mismatched nonce or an
 * empty `code_verifier`, a service that dropped either would sail through the
 * whole suite and fail only in production against real Google.
 *
 * Test flow: `authorizeUrl({state, nonce, codeChallenge})` → `issueCode(state)`
 * (the provider "authenticating the user") → `exchange({code, ...})`.
 */
export class InMemoryOAuthProvider implements OAuthProvider {
  readonly redirectUri: string;
  /** Every `authorizeUrl` call that was accepted, in order. */
  readonly authorizations: RecordedAuthorization[] = [];
  /** Every `exchange` call, verbatim, including the ones that were rejected. */
  readonly exchanges: ExchangeParams[] = [];

  readonly #codes = new Map<string, IssuedCode>();
  #nextCode = 1;

  constructor(opts: InMemoryOAuthProviderOptions = {}) {
    this.redirectUri = opts.redirectUri ?? IN_MEMORY_REDIRECT_URI;
  }

  authorizeUrl(params: AuthorizeParams): string {
    // THROW, not a silent default: an empty value here means the caller never
    // minted one, which is a bug in our code, not a user-input error.
    if (params.state.length === 0) throw new Error("InMemoryOAuthProvider: state is empty");
    if (params.nonce.length === 0) throw new Error("InMemoryOAuthProvider: nonce is empty");
    if (params.codeChallenge.length === 0) {
      throw new Error("InMemoryOAuthProvider: codeChallenge is empty");
    }

    this.authorizations.push({
      state: params.state,
      nonce: params.nonce,
      codeChallenge: params.codeChallenge,
    });

    const url = new URL(IN_MEMORY_AUTHORIZE_URL);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("state", params.state);
    url.searchParams.set("nonce", params.nonce);
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /**
   * Mint an authorization code for a state that was actually authorized, as the
   * provider would after the user consents. REFUSES an unknown state: a test
   * that "signs in" without going through `authorizeUrl` is not exercising the
   * flow the service must implement.
   */
  issueCode(state: string, identity: OAuthIdentity = IN_MEMORY_DEFAULT_IDENTITY): string {
    const authorization = this.authorizations.find((a) => a.state === state);
    if (authorization === undefined) {
      throw new Error(`InMemoryOAuthProvider: no authorization for state ${state}`);
    }
    const code = `in-memory-code-${this.#nextCode++}`;
    this.#codes.set(code, { nonce: authorization.nonce, identity });
    return code;
  }

  async exchange(params: ExchangeParams): Promise<ExchangeResult> {
    // Recorded FIRST and verbatim, so a test can assert what a rejected caller
    // actually sent, not just that it was rejected.
    this.exchanges.push({ ...params });

    // PKCE before anything else: an empty verifier means the service never
    // threaded it, and that is the finding a doubly-broken caller should see
    // first (a missing verifier makes the nonce comparison moot anyway).
    if (params.codeVerifier.length === 0) {
      return fail(
        "pkce_missing",
        "in-memory oauth: codeVerifier is empty — PKCE was not threaded through",
      );
    }

    const issued = this.#codes.get(params.code);
    if (issued === undefined) {
      return fail("unknown_code", "in-memory oauth: unknown authorization code");
    }

    // Plain `!==` and not a constant-time compare: this is a test double, both
    // values are ours, and there is no attacker on this path.
    if (params.expectedNonce !== issued.nonce) {
      return fail(
        "nonce_mismatch",
        "in-memory oauth: nonce does not match the one recorded at authorize time",
      );
    }

    return { ok: true, identity: issued.identity };
  }
}
