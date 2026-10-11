/**
 * `GoogleOAuthProvider` — the real HTTP adapter behind the OAuth port, plus the
 * boot-time `googleOAuthFromEnv` factory (issue #209, PR 4).
 *
 * Every test injects `fetch`: NO network, NO real Google credentials. The happy
 * path runs against {@link FakeGoogleIdp}, which mints a GENUINELY signed RS256
 * ID token and serves a real JWKS over the same injected transport, so the
 * exchange drives the PRODUCTION verifier rather than a bypass.
 *
 * Three properties carry the security weight here and each gets exact-value
 * assertions rather than "it worked":
 *
 *  1. the requested scope is EXACTLY `openid email` — `profile` must appear
 *     nowhere in the authorize URL, because requesting it would put "See your
 *     personal info" on the consent screen and drag PII into §5.14 erasure;
 *  2. the `redirect_uri` at the token exchange is the BYTE-IDENTICAL string sent
 *     at authorize time (asserted by comparing the two, never by writing the
 *     same literal twice — that would pass even if both drifted together);
 *  3. the client secret never reaches a log line, an error, or any serialization
 *     of the provider — asserted by searching the output for the secret VALUE,
 *     including against a token endpoint that deliberately echoes it back.
 */
import { describe, expect, it } from "bun:test";
import {
  GoogleOAuthError,
  GoogleOAuthProvider,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_OAUTH_CALLBACK_PATH,
  GOOGLE_OAUTH_SCOPE,
  GOOGLE_REGISTERED_REDIRECT_ORIGINS,
  GOOGLE_TOKEN_RESPONSE_MAX_BYTES,
  GOOGLE_TOKEN_URL,
  googleOAuthFromEnv,
} from "./google-oauth.ts";
import { GoogleJwks } from "./google-id-token.ts";
import type { ExchangeResult } from "./oauth.ts";
import { FakeGoogleIdp } from "../../../packages/test-fakes/google-oauth/index.ts";

const CLIENT_ID = "111111111111-samographprod.apps.googleusercontent.com";
/** Not a real secret — a fixed literal, shaped like Google's, used as a needle. */
const CLIENT_SECRET = "GOCSPX-not-a-real-secret-fixture";
const REDIRECT_URI = "https://samograph.samo.team/auth/google/callback";
const STATE = "state-abc";
const NONCE = "n-0S6_WzA2Mj";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE = "4/0AY0e-g7authorization-code";
/** Fixed epoch MILLISECONDS; the fake IdP mints exp/iat from the same instant. */
const T0 = 1_770_000_000_000;

interface Captured {
  url: string;
  init: RequestInit;
}

/**
 * A transport that answers the pinned TOKEN endpoint from `respond` and hands
 * everything else (i.e. the JWKS fetch) to the fake IdP. A provider that
 * invented its own token URL would get the IdP's 404 and fail loudly.
 */
function transport(
  idp: FakeGoogleIdp,
  captured: Captured[],
  respond: (init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === GOOGLE_TOKEN_URL) {
      captured.push({ url, init: init ?? {} });
      return await respond(init);
    }
    return idp.fetchImpl(input as never, init);
  }) as typeof fetch;
}

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Harness {
  idp: FakeGoogleIdp;
  provider: GoogleOAuthProvider;
  captured: Captured[];
}

function harness(
  respond: (idp: FakeGoogleIdp, init?: RequestInit) => Response | Promise<Response>,
  opts: { timeoutMs?: number; redirectUri?: string } = {},
): Harness {
  const idp = new FakeGoogleIdp({ clientId: CLIENT_ID, nonce: NONCE, nowMs: T0 });
  const captured: Captured[] = [];
  const fetchImpl = transport(idp, captured, (init) => respond(idp, init));
  const provider = new GoogleOAuthProvider({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: opts.redirectUri ?? REDIRECT_URI,
    fetchImpl,
    timeoutMs: opts.timeoutMs,
    jwks: new GoogleJwks({ fetchImpl }),
  });
  return { idp, provider, captured };
}

function exchange(
  provider: GoogleOAuthProvider,
  over: Partial<{ code: string; codeVerifier: string; expectedNonce: string }> = {},
): Promise<ExchangeResult> {
  return provider.exchange({
    code: over.code ?? CODE,
    codeVerifier: over.codeVerifier ?? VERIFIER,
    expectedNonce: over.expectedNonce ?? NONCE,
    nowMs: T0,
  });
}

function formOf(captured: Captured[]): URLSearchParams {
  return new URLSearchParams(String(captured[0].init.body));
}

// ─────────────────────────────────────────────────────────────────────────────
// authorize URL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A RAW TCP server that speaks just enough HTTP/1.1 to answer one request with a
 * 200 whose `Content-Length` promises more bytes than it ever sends, and then
 * kills the socket. `Bun.serve` cannot express this — it rewrites a short body
 * into a clean chunked response, which the client reads as a SUCCESSFUL short
 * read — so the defect only reproduces against a real socket.
 *
 * This is the shape of a connection reset by a load balancer mid-body: the
 * status line and headers arrive (so `fetch` RESOLVES and `res.ok` is true) and
 * the failure lands later, inside the body read.
 */
function brokenBodyServer(opts: { terminateAfterMs: number }): {
  url: string;
  stop: () => void;
} {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {},
      data(socket) {
        socket.write(
          "HTTP/1.1 200 OK\r\n" +
            "content-type: application/json\r\n" +
            // Under the 16KB cap, so the byte budget is NOT what fails here.
            "content-length: 1000\r\n\r\n" +
            // A prefix of a plausible token response — deliberately truncated.
            '{"access_token":"ya29.partial","id_token":"eyJ',
        );
        socket.flush();
        setTimeout(() => socket.terminate(), opts.terminateAfterMs);
      },
    },
  });
  return {
    url: `http://127.0.0.1:${listener.port}${GOOGLE_OAUTH_CALLBACK_PATH}`,
    stop: () => listener.stop(true),
  };
}

/** A provider whose token endpoint is the local socket server, JWKS via the IdP. */
function providerAgainst(tokenUrl: string, timeoutMs?: number): GoogleOAuthProvider {
  const idp = new FakeGoogleIdp({ clientId: CLIENT_ID, nonce: NONCE, nowMs: T0 });
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    if (String(input) === GOOGLE_TOKEN_URL) return await fetch(tokenUrl, init);
    return idp.fetchImpl(input as never, init);
  }) as typeof fetch;
  return new GoogleOAuthProvider({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    fetchImpl,
    timeoutMs,
    jwks: new GoogleJwks({ fetchImpl }),
  });
}

/**
 * Turn a REJECTION into a value, so a broken contract shows up as a readable
 * diff instead of an unhandled rejection with no expected/actual to compare.
 */
async function settle(promise: Promise<ExchangeResult>): Promise<unknown> {
  try {
    return await promise;
  } catch (err) {
    const e = err as Error;
    return { threw: `THREW (contract VIOLATED): ${e.name} - ${e.message}` };
  }
}

describe("GoogleOAuthProvider.authorizeUrl", () => {
  const provider = new GoogleOAuthProvider({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  });
  const url = new URL(
    provider.authorizeUrl({ state: STATE, nonce: NONCE, codeChallenge: CHALLENGE }),
  );

  it("targets Google's pinned authorize endpoint", () => {
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTHORIZE_URL);
    expect(GOOGLE_AUTHORIZE_URL).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  });

  it("sends EXACTLY the expected query parameters — no more, no fewer", () => {
    expect([...url.searchParams.keys()].sort()).toEqual([
      "access_type",
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "nonce",
      "prompt",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
    ]);
  });

  it("pins each parameter to its exact value", () => {
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("access_type")).toBe("online");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("code_challenge")).toBe(CHALLENGE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(url.searchParams.get("nonce")).toBe(NONCE);
  });

  it("never requests `profile` — not in scope, not anywhere in the URL", () => {
    expect(GOOGLE_OAUTH_SCOPE).toBe("openid email");
    expect(url.searchParams.get("scope")).not.toContain("profile");
    expect(url.toString()).not.toContain("profile");
  });

  it("never leaks the client secret into the authorize URL", () => {
    expect(url.toString()).not.toContain(CLIENT_SECRET);
  });

  it("THROWS when state, nonce or the PKCE challenge is empty", () => {
    expect(() =>
      provider.authorizeUrl({ state: "", nonce: NONCE, codeChallenge: CHALLENGE }),
    ).toThrow(GoogleOAuthError);
    expect(() =>
      provider.authorizeUrl({ state: STATE, nonce: "", codeChallenge: CHALLENGE }),
    ).toThrow(/nonce/);
    expect(() =>
      provider.authorizeUrl({ state: STATE, nonce: NONCE, codeChallenge: "" }),
    ).toThrow(/codeChallenge/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// token exchange — the request
// ─────────────────────────────────────────────────────────────────────────────

describe("GoogleOAuthProvider.exchange — the request on the wire", () => {
  it("POSTs client_secret_post form data to the pinned token endpoint", async () => {
    const { provider, captured, idp } = harness((i) =>
      tokenResponse({ id_token: i.mint(), token_type: "Bearer" }),
    );
    await exchange(provider);

    expect(GOOGLE_TOKEN_URL).toBe("https://oauth2.googleapis.com/token");
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(GOOGLE_TOKEN_URL);
    expect(captured[0].init.method).toBe("POST");
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    // EXACTLY one header: this is what pins `client_secret_post`. A provider that
    // switched to client_secret_basic would put the secret in an Authorization
    // header, which the form-field assertions below would not notice.
    expect(Object.keys(headers).sort()).toEqual(["content-type"]);
    // The JWKS fetch went to Google's pinned certs URL, not to some invented one.
    expect(idp.fetchCount).toBe(1);
  });

  it("sends EXACTLY the six form fields, with exact values", async () => {
    const { provider, captured } = harness((i) => tokenResponse({ id_token: i.mint() }));
    await exchange(provider);
    const form = formOf(captured);

    expect([...form.keys()].sort()).toEqual([
      "client_id",
      "client_secret",
      "code",
      "code_verifier",
      "grant_type",
      "redirect_uri",
    ]);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe(CODE);
    expect(form.get("code_verifier")).toBe(VERIFIER);
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
  });

  it("sends a redirect_uri BYTE-IDENTICAL to the one in the authorize URL", async () => {
    const { provider, captured } = harness((i) => tokenResponse({ id_token: i.mint() }));
    const authorizeRedirect = new URL(
      provider.authorizeUrl({ state: STATE, nonce: NONCE, codeChallenge: CHALLENGE }),
    ).searchParams.get("redirect_uri");
    await exchange(provider);

    // Compared against the OTHER call's value, never against a second literal:
    // two literals would still agree if both drifted from what Google has.
    expect(formOf(captured).get("redirect_uri")).toBe(authorizeRedirect);
    expect(formOf(captured).get("redirect_uri")).toBe(provider.redirectUri);
  });

  it("bounds the request with an abort signal", async () => {
    const { provider, captured } = harness((i) => tokenResponse({ id_token: i.mint() }));
    await exchange(provider);

    expect(captured[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// token exchange — the result
// ─────────────────────────────────────────────────────────────────────────────

describe("GoogleOAuthProvider.exchange — the verified identity", () => {
  it("returns the identity from a GENUINELY signed RS256 ID token", async () => {
    const { provider } = harness((i) =>
      tokenResponse({
        access_token: "ya29.not-used",
        expires_in: 3599,
        scope: "openid https://www.googleapis.com/auth/userinfo.email",
        token_type: "Bearer",
        id_token: i.mint(),
      }),
    );

    expect(await exchange(provider)).toEqual({
      ok: true,
      identity: {
        provider: "google",
        subject: "117000000000000000001",
        email: "alice@example.com",
        emailVerified: true,
      },
    });
  });

  it("REPORTS email_verified:false rather than swallowing it (the service enforces)", async () => {
    const { provider } = harness((i) =>
      tokenResponse({ id_token: i.mint({ claims: { email_verified: false } }) }),
    );

    expect(await exchange(provider)).toEqual({
      ok: true,
      identity: {
        provider: "google",
        subject: "117000000000000000001",
        email: "alice@example.com",
        emailVerified: false,
      },
    });
  });

  it("threads expectedNonce into the verifier — a mismatched nonce REJECTS", async () => {
    const { provider } = harness((i) => tokenResponse({ id_token: i.mint() }));

    expect(await exchange(provider, { expectedNonce: "a-different-nonce" })).toEqual({
      ok: false,
      code: "SAMO-AUTH-008",
      reason: "id_token_rejected",
      detail: "google id token rejected: nonce_mismatch",
    });
  });

  it("REJECTS an ID token minted for a different OAuth client", async () => {
    const { provider } = harness((i) =>
      tokenResponse({ id_token: i.mint({ claims: { aud: "someone-else", azp: undefined } }) }),
    );

    expect(await exchange(provider)).toEqual({
      ok: false,
      code: "SAMO-AUTH-008",
      reason: "id_token_rejected",
      detail: "google id token rejected: aud_mismatch",
    });
  });

  it("REJECTS an alg:none token — the verifier really runs", async () => {
    const { provider } = harness((i) => tokenResponse({ id_token: i.mintAlgNone() }));

    expect(await exchange(provider)).toEqual({
      ok: false,
      code: "SAMO-AUTH-008",
      reason: "id_token_rejected",
      detail: "google id token rejected: alg_not_rs256",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// token exchange — failure mapping, and the secret never escaping
// ─────────────────────────────────────────────────────────────────────────────

describe("GoogleOAuthProvider.exchange — typed failures, never a throw", () => {
  it("maps a 400 whose body ECHOES the client secret to 008, logging no secret", async () => {
    const { provider } = harness(() =>
      tokenResponse(
        {
          error: "invalid_grant",
          error_description: `bad grant for client_secret=${CLIENT_SECRET} redirect_uri=${REDIRECT_URI}`,
        },
        400,
      ),
    );

    const result = await exchange(provider);
    expect(result).toEqual({
      ok: false,
      code: "SAMO-AUTH-008",
      reason: "http_error",
      detail: "google token exchange failed: HTTP 400",
    });
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
    // Google's error_description reflects request parameters back; none of it
    // may reach a log line, a URL, or a response body.
    expect(JSON.stringify(result)).not.toContain("invalid_grant");
  });

  it("maps a 5xx to SAMO-AUTH-500 — our side, retryable — not to 008", async () => {
    const { provider } = harness(() => tokenResponse({ error: "backend_error" }, 503));

    expect(await exchange(provider)).toEqual({
      ok: false,
      code: "SAMO-AUTH-500",
      reason: "http_error",
      detail: "google token exchange failed: HTTP 503",
    });
  });

  it("maps a transport rejection to 500 and redacts the secret from its message", async () => {
    const { provider } = harness(() => {
      throw new TypeError(`connect ECONNREFUSED (secret was ${CLIENT_SECRET})`);
    });

    const result = await exchange(provider);
    expect(result).toEqual({
      ok: false,
      code: "SAMO-AUTH-500",
      reason: "transport_failed",
      detail: "google token exchange failed: no response from the token endpoint",
    });
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });

  it("RESOLVES to 500 on a hanging endpoint instead of hanging the sign-in", async () => {
    const { provider } = harness(
      (_i, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      { timeoutMs: 20 },
    );

    expect(await exchange(provider)).toEqual({
      ok: false,
      code: "SAMO-AUTH-500",
      reason: "transport_failed",
      detail: "google token exchange failed: no response from the token endpoint",
    });
  });

  it("maps a non-JSON 200 to 008 without echoing the body", async () => {
    const { provider } = harness(() =>
      tokenResponse(`<html>gateway error ${CLIENT_SECRET}</html>`),
    );

    const result = await exchange(provider);
    expect(result).toEqual({
      ok: false,
      code: "SAMO-AUTH-008",
      reason: "malformed_response",
      detail: "google token exchange failed: response was not a JSON object",
    });
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
  });

  it("maps a 200 with no id_token to 008", async () => {
    const { provider } = harness(() =>
      tokenResponse({ access_token: "ya29.only", token_type: "Bearer" }),
    );

    expect(await exchange(provider)).toEqual({
      ok: false,
      code: "SAMO-AUTH-008",
      reason: "missing_id_token",
      detail: "google token exchange failed: response carried no id_token",
    });
  });

  it("CAPS the response body instead of buffering whatever it is sent", async () => {
    const { provider } = harness(() =>
      tokenResponse(
        JSON.stringify({
          id_token: "x",
          pad: "p".repeat(GOOGLE_TOKEN_RESPONSE_MAX_BYTES + 1),
        }),
      ),
    );

    expect(await exchange(provider)).toEqual({
      ok: false,
      code: "SAMO-AUTH-500",
      reason: "response_too_large",
      detail: `google token exchange failed: response body exceeds ${GOOGLE_TOKEN_RESPONSE_MAX_BYTES} bytes`,
    });
  });
  // The body-read step is the ONE await in `exchange` that used to sit outside a
  // try/catch. A 200 whose body then dies made `exchange` REJECT, breaking the
  // "Never throws" contract in `oauth.ts` that every caller is written against.
  it("RESOLVES to 500 when the socket is reset MID-BODY after a 200", async () => {
    const server = brokenBodyServer({ terminateAfterMs: 10 });
    try {
      const provider = providerAgainst(server.url);
      expect(await settle(exchange(provider))).toEqual({
        ok: false,
        code: "SAMO-AUTH-500",
        reason: "transport_failed",
        detail: "google token exchange failed: the response body did not arrive intact",
      });
    } finally {
      server.stop();
    }
  });

  it("RESOLVES to 500 when the abort timeout fires WHILE the body streams", async () => {
    // The socket stays open past the timeout, so the abort lands during the body
    // read rather than during the request — a distinct trigger, same guard.
    const server = brokenBodyServer({ terminateAfterMs: 5_000 });
    try {
      const provider = providerAgainst(server.url, 50);
      expect(await settle(exchange(provider))).toEqual({
        ok: false,
        code: "SAMO-AUTH-500",
        reason: "transport_failed",
        detail: "google token exchange failed: the response body did not arrive intact",
      });
    } finally {
      server.stop();
    }
  });
});

describe("GoogleOAuthProvider — the client secret is unreachable off the instance", () => {
  it("is invisible to JSON.stringify, Bun.inspect, String() and Object.keys", () => {
    const { provider } = harness((i) => tokenResponse({ id_token: i.mint() }));

    expect(JSON.stringify(provider)).not.toContain(CLIENT_SECRET);
    expect(Bun.inspect(provider)).not.toContain(CLIENT_SECRET);
    expect(String(provider)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(Object.entries(provider))).not.toContain(CLIENT_SECRET);
    expect(Object.getOwnPropertyNames(provider)).toEqual(["redirectUri"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// googleOAuthFromEnv — the boot-time factory
// ─────────────────────────────────────────────────────────────────────────────

const WEB_ORIGIN = "https://samograph.samo.team";

describe("googleOAuthFromEnv — presence gate", () => {
  it("returns undefined when NEITHER credential is set (the feature is simply OFF)", () => {
    expect(googleOAuthFromEnv({}, WEB_ORIGIN)).toBeUndefined();
    expect(
      googleOAuthFromEnv(
        { GOOGLE_OAUTH_CLIENT_ID: "  ", GOOGLE_OAUTH_CLIENT_SECRET: "" },
        WEB_ORIGIN,
      ),
    ).toBeUndefined();
  });

  it("THROWS naming the MISSING secret, echoing no value, when only the id is set", () => {
    let thrown: unknown;
    try {
      googleOAuthFromEnv({ GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID }, WEB_ORIGIN);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GoogleOAuthError);
    const message = (thrown as Error).message;
    expect(message).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
    expect(message).not.toContain(CLIENT_ID);
  });

  it("THROWS naming the MISSING id, echoing no secret, when only the secret is set", () => {
    let thrown: unknown;
    try {
      googleOAuthFromEnv({ GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET }, WEB_ORIGIN);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GoogleOAuthError);
    const message = (thrown as Error).message;
    expect(message).toContain("GOOGLE_OAUTH_CLIENT_ID");
    expect(message).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain(
      CLIENT_SECRET,
    );
  });

  it("constructs a provider when BOTH are set, deriving the redirect URI", () => {
    const provider = googleOAuthFromEnv(
      { GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
      WEB_ORIGIN,
    );
    expect(provider).toBeInstanceOf(GoogleOAuthProvider);
    expect(provider?.redirectUri).toBe("https://samograph.samo.team/auth/google/callback");
    expect(GOOGLE_OAUTH_CALLBACK_PATH).toBe("/auth/google/callback");
  });

  it("strips a trailing slash off the web origin rather than doubling it", () => {
    const provider = googleOAuthFromEnv(
      { GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
      "https://samograph.samo.team/",
    );
    expect(provider?.redirectUri).toBe("https://samograph.samo.team/auth/google/callback");
  });
});

/** Both credentials present, so every case below exercises the URI resolution. */
function envWith(redirectUri?: string): Record<string, string | undefined> {
  return {
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: redirectUri,
  };
}

describe("googleOAuthFromEnv — redirect URI resolution", () => {
  it("pins the FULL registered-origin list as an exact array", () => {
    // The WHOLE list, in order, as one exact value — not `toContain`. Every
    // entry here is a host someone must have registered by hand in the Google
    // console, so an addition or a removal has to show up as a deliberate line
    // in this diff rather than sliding in under a membership check.
    expect([...GOOGLE_REGISTERED_REDIRECT_ORIGINS]).toEqual([
      "https://samograph.dev",
      "https://samograph.samo.team",
      "https://samograph-main.samo.cat",
      "http://localhost:3000",
    ]);
  });

  it("accepts each of the four REGISTERED derived origins", () => {
    for (const [origin, expected] of [
      ["https://samograph.dev", "https://samograph.dev/auth/google/callback"],
      ["https://samograph.samo.team", "https://samograph.samo.team/auth/google/callback"],
      [
        "https://samograph-main.samo.cat",
        "https://samograph-main.samo.cat/auth/google/callback",
      ],
      ["http://localhost:3000", "http://localhost:3000/auth/google/callback"],
    ] as const) {
      expect(googleOAuthFromEnv(envWith(), origin)?.redirectUri).toBe(expected);
    }
  });

  it("derives EXACTLY https://samograph.dev/auth/google/callback for samograph.dev", () => {
    // `server.ts` falls back to https://samograph.dev when neither BASE_URL nor
    // WEB_ORIGIN is set, and that host is now registered with Google, so the
    // derivation must produce the callback path — NOT /auth/callback, which is
    // the magic-link callback and is what a hand-registered client most often
    // gets wrong.
    const provider = googleOAuthFromEnv(envWith(), "https://samograph.dev");
    expect(provider?.redirectUri).toBe("https://samograph.dev/auth/google/callback");
  });

  it("THROWS on a derived branch-preview origin — previews get no Google by design", () => {
    expect(() =>
      googleOAuthFromEnv(envWith(), "https://samograph-somebranch.samo.cat"),
    ).toThrow(/GOOGLE_OAUTH_REDIRECT_URI/);
  });

  it("lets an EXPLICIT override name a host the derived allowlist would refuse", () => {
    const uri = "https://samograph-somebranch.samo.cat/auth/google/callback";
    // The web origin is one the derivation itself would THROW on, so this also
    // proves the override short-circuits the allowlist rather than merely
    // overwriting a value the allowlist already let through.
    expect(
      googleOAuthFromEnv(envWith(uri), "https://samograph-otherbranch.samo.cat")?.redirectUri,
    ).toBe(uri);
  });

  it("returns the override BYTE-IDENTICALLY, never a re-serialized URL", () => {
    const uri = "http://localhost:3000/auth/google/callback";
    expect(googleOAuthFromEnv(envWith(uri), WEB_ORIGIN)?.redirectUri).toBe(uri);
  });

  it("REJECTS a non-canonical override rather than silently normalizing it", () => {
    // Each of these is accepted by `new URL(...)` and comes back as a DIFFERENT
    // string, so an implementation that re-serialized would quietly send Google
    // something the operator never registered. Found by mutation testing: with
    // only canonical fixtures, "returns the override verbatim" and "returns
    // `new URL(override).toString()`" are indistinguishable.
    for (const [given, canonical] of [
      ["https://x.test:443/auth/google/callback", "https://x.test/auth/google/callback"],
      ["https://X.TEST/auth/google/callback", "https://x.test/auth/google/callback"],
      [
        "http://localhost:3000/auth/google/../google/callback",
        "http://localhost:3000/auth/google/callback",
      ],
    ] as const) {
      expect(new URL(given).toString()).toBe(canonical);
      expect(() => googleOAuthFromEnv(envWith(given), WEB_ORIGIN)).toThrow(
        /GOOGLE_OAUTH_REDIRECT_URI/,
      );
    }
  });

  it("REJECTS http on a non-localhost host", () => {
    expect(() =>
      googleOAuthFromEnv(envWith("http://evil.test/auth/google/callback"), WEB_ORIGIN),
    ).toThrow(/GOOGLE_OAUTH_REDIRECT_URI/);
  });

  it("REJECTS a query string", () => {
    expect(() =>
      googleOAuthFromEnv(envWith("https://x.test/auth/google/callback?a=1"), WEB_ORIGIN),
    ).toThrow(/GOOGLE_OAUTH_REDIRECT_URI/);
  });

  it("REJECTS a fragment", () => {
    expect(() =>
      googleOAuthFromEnv(envWith("https://x.test/auth/google/callback#f"), WEB_ORIGIN),
    ).toThrow(/GOOGLE_OAUTH_REDIRECT_URI/);
  });

  it("REJECTS a wrong path, including a near-miss trailing slash", () => {
    expect(() =>
      googleOAuthFromEnv(envWith("https://x.test/auth/callback"), WEB_ORIGIN),
    ).toThrow(/GOOGLE_OAUTH_REDIRECT_URI/);
    expect(() =>
      googleOAuthFromEnv(envWith("https://x.test/auth/google/callback/"), WEB_ORIGIN),
    ).toThrow(/GOOGLE_OAUTH_REDIRECT_URI/);
  });

  it("REJECTS embedded credentials and non-http(s) schemes", () => {
    expect(() =>
      googleOAuthFromEnv(envWith("https://u:p@x.test/auth/google/callback"), WEB_ORIGIN),
    ).toThrow(/GOOGLE_OAUTH_REDIRECT_URI/);
    expect(() =>
      googleOAuthFromEnv(envWith("javascript:alert(1)"), WEB_ORIGIN),
    ).toThrow(/GOOGLE_OAUTH_REDIRECT_URI/);
  });

  it("REJECTS a value that is not a URL at all", () => {
    expect(() => googleOAuthFromEnv(envWith("not a url"), WEB_ORIGIN)).toThrow(
      /GOOGLE_OAUTH_REDIRECT_URI/,
    );
  });

  it("never echoes the client secret in ANY redirect-URI rejection", () => {
    for (const bad of [
      "http://evil.test/auth/google/callback",
      "https://x.test/auth/google/callback?a=1",
      "not a url",
    ]) {
      let thrown: unknown;
      try {
        googleOAuthFromEnv(envWith(bad), WEB_ORIGIN);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as Error).message).not.toContain(CLIENT_SECRET);
    }
  });
});
