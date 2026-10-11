/**
 * The REAL Google adapter behind the OAuth port (issue #209, SPEC §5.1
 * amendment S5-1) — a confidential authorization-code client with PKCE S256 and
 * a nonce, terminating in a locally verified RS256 ID token.
 *
 * Shaped like `resend-email.ts`: pinned endpoint constants, an injected `fetch`
 * so every test runs with no network and no real credentials, a hard timeout so
 * a stuck endpoint fails typed instead of hanging a sign-in, a typed error class,
 * and an env-driven factory. Two things are stricter here than in the email
 * adapter, because this is a credential path:
 *
 *  - the client secret lives in a `#` private field, so it is unreachable off
 *    the instance and invisible to `JSON.stringify` / `Bun.inspect` / a logger
 *    that dumps the object;
 *  - NOTHING from Google's response is ever echoed. Google's `error_description`
 *    reflects our own request parameters back (`redirect_uri=...`,
 *    `client_secret=...` on some errors), so every failure detail here is fixed
 *    text derived from our own control flow — there is no body to redact because
 *    no body is ever read into a message.
 *
 * `googleOAuthFromEnv` must NOT be called at module top level. CI sets no
 * `SAMO_ENV`, so a module-level guard would make this file un-importable under
 * `bun test`; the server entrypoints call it inside their start functions.
 */
import {
  GoogleJwks,
  verifyGoogleIdToken,
  type JwksKeySource,
} from "./google-id-token.ts";
import type {
  AuthorizeParams,
  ExchangeParams,
  ExchangeResult,
  OAuthExchangeRejection,
  OAuthProvider,
} from "./oauth.ts";
import { present } from "../../../packages/shared/config/env.ts";

/** Google's OAuth 2.0 authorization endpoint. Compile-time literal, never discovered. */
export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * Google's token endpoint. Compile-time literal for the same reason the JWKS URL
 * is one: runtime `.well-known` discovery is a pure SSRF/hijack surface for zero
 * benefit, and if Google ever moves this that is a reviewed code change.
 */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * EXACTLY the scopes we need, and no more.
 *
 * `profile` is deliberately absent: it would put "See your personal info,
 * including any personal info you've made publicly available" on the consent
 * screen, drag name/picture PII into §5.14 erasure, and buy us nothing — we key
 * identity on `sub` and only need the address for the account link. Adding it
 * later is a product decision with a privacy review, not a convenience edit.
 */
export const GOOGLE_OAUTH_SCOPE = "openid email";

/** The one path Google is allowed to redirect back to. */
export const GOOGLE_OAUTH_CALLBACK_PATH = "/auth/google/callback";

/** Bound the token exchange; a stuck endpoint must fail typed, not hang a login. */
export const GOOGLE_TOKEN_TIMEOUT_MS = 10_000;

/**
 * Hard cap on the token response we will buffer. A well-formed response is an
 * access token plus an ID token (itself capped at 8KB by the verifier), so 16KB
 * is generous; the cap exists so a hostile or broken endpoint cannot make us
 * buffer an unbounded body.
 */
export const GOOGLE_TOKEN_RESPONSE_MAX_BYTES = 16 * 1024;

/**
 * The redirect origins Google is configured to accept, across the two OAuth
 * clients (`samograph-prod` and `samograph-nonprod` — see
 * `docs/runbooks/google-oauth.md`). Google exact-matches redirect URIs and
 * allows no wildcards, so this list is finite BY DESIGN: branch previews get no
 * Google credentials and keep working on magic link.
 *
 * Checked only against a DERIVED redirect URI, and it fails at BOOT rather than
 * at every user's click. An operator who genuinely needs a host that is not on
 * this list sets `GOOGLE_OAUTH_REDIRECT_URI`, which skips the list (they have
 * asserted the host) but still gets the shape check below.
 *
 * NOTE on `https://samograph.dev`: it is here because it is a real registered
 * host, but it is ALSO the hard-coded last-resort default in
 * `apps/app-api/server.ts` — `resolveMagicLinkBaseUrl(env, "https://samograph.dev")`.
 * So this list no longer catches an environment that loses both `BASE_URL` and
 * `WEB_ORIGIN`: such an environment silently falls back to `samograph.dev`,
 * sails through here, and — if the credentials it holds belong to a client
 * registered for a DIFFERENT host — dies at Google with `redirect_uri_mismatch`
 * on every user's click, with nothing in our logs. The guard against that is
 * per-env config, not this list: every environment must set its own
 * `BASE_URL`/`WEB_ORIGIN`, or pin `GOOGLE_OAUTH_REDIRECT_URI` outright.
 */
export const GOOGLE_REGISTERED_REDIRECT_ORIGINS = [
  "https://samograph.dev",
  "https://samograph.samo.team",
  "https://samograph-main.samo.cat",
  "http://localhost:3000",
] as const;

/** Hosts allowed to use plain http — Google permits loopback only. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Typed failure for a Google OAuth CONFIGURATION or CALLER problem — a
 * misconfigured env, or an empty state/nonce/challenge, both of which are our
 * bugs and must be loud. Runtime exchange failures are NOT thrown; they come
 * back as an `{ok:false}` {@link ExchangeResult}.
 *
 * No credential value is ever put in the message.
 */
export class GoogleOAuthError extends Error {
  override readonly name = "GoogleOAuthError";
}

export interface GoogleOAuthProviderOptions {
  /** The OAuth client id; also pinned as the required `aud` on the ID token. */
  clientId: string;
  /** The OAuth client secret (`client_secret_post`). Never logged, never echoed. */
  clientSecret: string;
  /** Resolved ONCE and sent byte-identically at /authorize and at the exchange. */
  redirectUri: string;
  /** Injected transport for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Exchange timeout; defaults to {@link GOOGLE_TOKEN_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Signing keys for ID-token verification; defaults to a fresh {@link GoogleJwks}. */
  jwks?: JwksKeySource;
}

/**
 * Read a response body with a hard byte budget, so a hostile or broken endpoint
 * cannot make us buffer an unbounded amount. Returns null when the cap is
 * exceeded (or the declared length already blows it).
 *
 * Deliberately a local copy of the same helper in `google-id-token.ts` rather
 * than an export from it: that module is the ID-token verifier and this one is
 * the HTTP client, and coupling them for eight lines would put a shared internal
 * on the verifier's public surface.
 */
async function readCappedText(res: Response, maxBytes: number): Promise<string | null> {
  const declared = res.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length > maxBytes) return null;
  }
  const stream = res.body;
  if (stream === null) {
    const text = await res.text();
    return Buffer.byteLength(text, "utf8") > maxBytes ? null : text;
  }
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reject(
  code: "SAMO-AUTH-008" | "SAMO-AUTH-500",
  reason: OAuthExchangeRejection,
  detail: string,
): ExchangeResult {
  return { ok: false, code, reason, detail };
}

/**
 * The production Google OAuth client.
 *
 * `redirectUri` is the ONLY public own property — everything else, the client
 * secret included, is a `#` private field. That is asserted in the tests: a
 * logger, an error serializer or a debug dump that walks the instance finds
 * nothing but the redirect URI.
 */
export class GoogleOAuthProvider implements OAuthProvider {
  readonly redirectUri: string;

  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #jwks: JwksKeySource;

  constructor(opts: GoogleOAuthProviderOptions) {
    this.redirectUri = opts.redirectUri;
    this.#clientId = opts.clientId;
    this.#clientSecret = opts.clientSecret;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? GOOGLE_TOKEN_TIMEOUT_MS;
    this.#jwks = opts.jwks ?? new GoogleJwks({ fetchImpl: opts.fetchImpl });
  }

  authorizeUrl(params: AuthorizeParams): string {
    // THROW: an empty value means the caller never minted one. Redirecting to
    // Google without a state, a nonce or a PKCE challenge would produce a login
    // that LOOKS like it works while every defence in the callback is disarmed.
    if (params.state.length === 0) throw new GoogleOAuthError("authorizeUrl: state is empty");
    if (params.nonce.length === 0) throw new GoogleOAuthError("authorizeUrl: nonce is empty");
    if (params.codeChallenge.length === 0) {
      throw new GoogleOAuthError("authorizeUrl: codeChallenge is empty");
    }

    const url = new URL(GOOGLE_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.#clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", GOOGLE_OAUTH_SCOPE);
    // `online`: we never want a refresh token. We authenticate the user once and
    // mint our own session; a refresh token would be a long-lived credential
    // with nothing to spend it on.
    url.searchParams.set("access_type", "online");
    // Always show the chooser. Silent re-auth into whichever account the browser
    // happens to hold is exactly the surprise that gets a user into the wrong
    // tenant on a shared machine.
    url.searchParams.set("prompt", "select_account");
    url.searchParams.set("state", params.state);
    url.searchParams.set("nonce", params.nonce);
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchange(params: ExchangeParams): Promise<ExchangeResult> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      // The SAME string the authorize redirect carried — not re-derived here.
      // Google compares them byte for byte and rejects the exchange otherwise.
      redirect_uri: this.redirectUri,
      code_verifier: params.codeVerifier,
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
    });

    let res: Response;
    try {
      res = await this.#fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        // `client_secret_post`: exactly one header, so the secret is a form
        // field and never lands in an Authorization header a proxy might log.
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      // The thrown error is DISCARDED rather than formatted: a transport error
      // message can quote the request (and therefore the secret), and "which
      // syscall failed" tells the sign-in path nothing it can act on.
      return reject(
        "SAMO-AUTH-500",
        "transport_failed",
        "google token exchange failed: no response from the token endpoint",
      );
    }

    if (!res.ok) {
      // The body is never read. Google's `error_description` reflects our own
      // request parameters back, so reading it only creates something to leak.
      // 5xx is Google's infrastructure (retryable, our-fault bucket); 4xx means
      // our request was refused.
      return reject(
        res.status >= 500 ? "SAMO-AUTH-500" : "SAMO-AUTH-008",
        "http_error",
        `google token exchange failed: HTTP ${res.status}`,
      );
    }

    // GUARDED, exactly as `google-id-token.ts` guards its own body read: the
    // status line arriving does NOT mean the body will. A reset mid-body, or the
    // abort timeout firing while the body is still streaming, rejects HERE — and
    // an unguarded await would turn that into a THROW out of `exchange`, which
    // the "Never throws" contract in `oauth.ts` forbids and no caller handles.
    let text: string | null;
    try {
      text = await readCappedText(res, GOOGLE_TOKEN_RESPONSE_MAX_BYTES);
    } catch {
      // Discarded, like the transport error above: a stream error message can
      // quote the request (and therefore the secret), and the detail must stay
      // fixed text derived from our own control flow.
      return reject(
        "SAMO-AUTH-500",
        "transport_failed",
        "google token exchange failed: the response body did not arrive intact",
      );
    }
    if (text === null) {
      return reject(
        "SAMO-AUTH-500",
        "response_too_large",
        `google token exchange failed: response body exceeds ${GOOGLE_TOKEN_RESPONSE_MAX_BYTES} bytes`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return reject(
        "SAMO-AUTH-008",
        "malformed_response",
        "google token exchange failed: response was not a JSON object",
      );
    }

    const idToken = (parsed as Record<string, unknown>).id_token;
    if (typeof idToken !== "string" || idToken.length === 0) {
      return reject(
        "SAMO-AUTH-008",
        "missing_id_token",
        "google token exchange failed: response carried no id_token",
      );
    }

    // The direct TLS channel to Google is NOT taken as proof: the ID token is
    // verified locally, in full, every time (issue #209 — the whole reason the
    // in-repo fake IdP is a real RSA signer).
    const verified = await verifyGoogleIdToken(idToken, {
      clientId: this.#clientId,
      expectedNonce: params.expectedNonce,
      jwks: this.#jwks,
      nowMs: params.nowMs,
    });
    if (!verified.ok) {
      return reject(
        "SAMO-AUTH-008",
        "id_token_rejected",
        `google id token rejected: ${verified.reason}`,
      );
    }

    return { ok: true, identity: verified.identity };
  }
}

/**
 * Shape-check a redirect URI. Applied to BOTH the derived default and an
 * explicit override, because the shape is what Google matches on:
 * https (http for loopback only), no credentials, no query, no fragment, and
 * exactly the callback path.
 *
 * Every rejection names `GOOGLE_OAUTH_REDIRECT_URI` — the var the operator has
 * to set to fix it — and echoes no credential.
 */
function assertRedirectUriShape(value: string, source: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GoogleOAuthError(
      `${source} is not a valid absolute URL — set GOOGLE_OAUTH_REDIRECT_URI to ` +
        `https://<host>${GOOGLE_OAUTH_CALLBACK_PATH}`,
    );
  }
  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new GoogleOAuthError(
      `${source} must use https (http is allowed only on localhost) — ` +
        `set GOOGLE_OAUTH_REDIRECT_URI accordingly`,
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new GoogleOAuthError(
      `${source} must not carry embedded credentials — set GOOGLE_OAUTH_REDIRECT_URI ` +
        `to a plain https URL`,
    );
  }
  if (url.search.length > 0) {
    throw new GoogleOAuthError(
      `${source} must not carry a query string — Google exact-matches the redirect ` +
        `URI; set GOOGLE_OAUTH_REDIRECT_URI without one`,
    );
  }
  if (url.hash.length > 0) {
    throw new GoogleOAuthError(
      `${source} must not carry a fragment — set GOOGLE_OAUTH_REDIRECT_URI without one`,
    );
  }
  if (url.pathname !== GOOGLE_OAUTH_CALLBACK_PATH) {
    throw new GoogleOAuthError(
      `${source} path must be exactly ${GOOGLE_OAUTH_CALLBACK_PATH} — ` +
        `set GOOGLE_OAUTH_REDIRECT_URI to https://<host>${GOOGLE_OAUTH_CALLBACK_PATH}`,
    );
  }
  // The value must ALREADY be canonical. We send it verbatim (see below), so a
  // form that URL parsing would normalise — an explicit `:443`, an uppercase
  // host, a doubled slash — is a value that will not byte-match what Google has
  // registered. Rejecting it at boot beats sending it and having every user's
  // click die at Google with `redirect_uri_mismatch` and nothing in our logs.
  // It also makes "we never normalise the operator's string" structural rather
  // than a promise: verbatim and canonical are the same string here.
  if (url.toString() !== value) {
    throw new GoogleOAuthError(
      `${source} is not in canonical form (it would normalise to a different string, ` +
        `so it cannot byte-match the URI registered with Google) — set ` +
        `GOOGLE_OAUTH_REDIRECT_URI to ${url.toString()}`,
    );
  }
}

/** Derive `<origin>/auth/google/callback`, against the registered-origin list. */
function deriveRedirectUri(webOrigin: string): string {
  let origin: string;
  try {
    origin = new URL(webOrigin).origin;
  } catch {
    throw new GoogleOAuthError(
      `cannot derive the Google redirect URI: the web origin is not a valid URL — ` +
        `set GOOGLE_OAUTH_REDIRECT_URI explicitly`,
    );
  }
  if (!(GOOGLE_REGISTERED_REDIRECT_ORIGINS as readonly string[]).includes(origin)) {
    // Fail at BOOT, naming the fix. The alternative is a server that starts
    // happily and dies at Google on every user's click with an error we never
    // see. Branch previews never reach here: with no credentials configured the
    // factory has already returned undefined.
    throw new GoogleOAuthError(
      `the derived Google redirect URI's origin is not one registered with Google ` +
        `(${GOOGLE_REGISTERED_REDIRECT_ORIGINS.join(", ")}) — set ` +
        `GOOGLE_OAUTH_REDIRECT_URI explicitly, or leave the Google credentials unset ` +
        `to run this environment on magic link only`,
    );
  }
  return `${origin}${GOOGLE_OAUTH_CALLBACK_PATH}`;
}

/**
 * The explicit `GOOGLE_OAUTH_REDIRECT_URI` override, or `undefined` when it is
 * unset or blank. Shared with the entrypoint tripwire (#209) for the same reason
 * {@link googleOAuthIsConfigured} is: an operator who pinned the URI has already
 * asserted the host, and both places must agree on what "pinned" means.
 */
export function googleOAuthRedirectUriOverride(
  env: Record<string, string | undefined>,
): string | undefined {
  return present(env.GOOGLE_OAUTH_REDIRECT_URI);
}

/**
 * Does this environment claim Google sign-in at all?
 *
 * THE single definition of "configured", shared by {@link googleOAuthFromEnv}
 * (which returns `undefined` exactly when this is `false`) and by the entrypoint
 * tripwire that refuses to let the hard-coded web-origin fallback silently
 * become a Google redirect origin (`assertGoogleWebOriginConfigured` in
 * `apps/app-api/server.ts`, #209). Two separate notions of "configured" that
 * disagree on a blank string would put the tripwire and the factory out of step,
 * so there is only one.
 *
 * `true` when EITHER credential is present, not both: exactly one set is a
 * half-configured client, which {@link googleOAuthFromEnv} already throws on —
 * that state must reach the throw, not slip past the tripwire. Whitespace-only
 * is absent (see {@link present}).
 */
export function googleOAuthIsConfigured(env: Record<string, string | undefined>): boolean {
  return (
    present(env.GOOGLE_OAUTH_CLIENT_ID) !== undefined ||
    present(env.GOOGLE_OAUTH_CLIENT_SECRET) !== undefined
  );
}

/**
 * Build the production Google provider from the environment, or `undefined`
 * when Google sign-in is simply OFF.
 *
 *  - NEITHER credential set → `undefined`. This is the repo's normal state until
 *    the owner supplies keys, and every environment that never gets them (all
 *    branch previews, by design). The app boots, `/auth/providers` reports
 *    `{google:false}`, the button does not render, magic link is unaffected.
 *  - EXACTLY ONE set → THROW, naming the missing var and echoing no value. A
 *    half-configured client is worse than an unconfigured one: the presence gate
 *    would say "configured", the button would render, and every sign-in would
 *    die at Google's token endpoint.
 *  - BOTH set → a provider, with the redirect URI resolved ONCE here and reused
 *    byte-identically at /authorize and at the exchange.
 *
 * Call this from inside a server entrypoint, never at module top level.
 */
export function googleOAuthFromEnv(
  env: Record<string, string | undefined>,
  webOrigin: string,
): GoogleOAuthProvider | undefined {
  const clientId = present(env.GOOGLE_OAUTH_CLIENT_ID);
  const clientSecret = present(env.GOOGLE_OAUTH_CLIENT_SECRET);

  if (!googleOAuthIsConfigured(env)) return undefined;
  if (clientSecret === undefined) {
    throw new GoogleOAuthError(
      "GOOGLE_OAUTH_CLIENT_ID is set but GOOGLE_OAUTH_CLIENT_SECRET is missing — " +
        "set both to enable Google sign-in, or neither to disable it",
    );
  }
  if (clientId === undefined) {
    throw new GoogleOAuthError(
      "GOOGLE_OAUTH_CLIENT_SECRET is set but GOOGLE_OAUTH_CLIENT_ID is missing — " +
        "set both to enable Google sign-in, or neither to disable it",
    );
  }

  const override = googleOAuthRedirectUriOverride(env);
  let redirectUri: string;
  if (override !== undefined) {
    assertRedirectUriShape(override, "GOOGLE_OAUTH_REDIRECT_URI");
    // Returned VERBATIM, never re-serialized through `URL`: Google matches the
    // string it has registered, and normalisation could silently change it.
    redirectUri = override;
  } else {
    redirectUri = deriveRedirectUri(webOrigin);
    assertRedirectUriShape(redirectUri, "the derived Google redirect URI");
  }

  return new GoogleOAuthProvider({ clientId, clientSecret, redirectUri });
}
