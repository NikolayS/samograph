/**
 * The three Google sign-in routes end to end (issue #209, PR 5 of 7; SPEC
 * amendment S5-1, §5.16 codes 006–010).
 *
 * These are FULL-STACK route tests, not service unit tests: every case below
 * drives `createGoogleAuthHandler` with a `Request` and asserts the `Response`.
 * The provider under test is the PRODUCTION {@link GoogleOAuthProvider}, wired to
 * a fake Google that is a real IdP — {@link FakeGoogleIdp} generates an RSA
 * keypair, serves a real JWKS document and mints genuinely signed RS256 ID
 * tokens, and {@link FakeGoogleServer} enforces PKCE S256 exactly as Google's
 * token endpoint does. Nothing here short-circuits the crypto, so a callback
 * that failed to thread the verifier or the nonce fails these tests instead of
 * failing in production.
 *
 * No network, no credentials, no database: `InMemoryUserStore` +
 * `InMemoryIdentityStore` stand in for the privileged Postgres stores, and the
 * clock is injected.
 */
import { describe, it, expect } from "bun:test";
import { FakeGoogleIdp, type MintOverrides } from "../../../packages/test-fakes/google-oauth/index.ts";
import { GoogleOAuthProvider, GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL } from "./google-oauth.ts";
import {
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_MS,
  DEFAULT_RETURN_TO,
  codeChallengeS256,
  signOAuthState,
  verifyOAuthState,
} from "./oauth-state.ts";
import { InMemoryUserStore } from "./stores.ts";
import { InMemoryIdentityStore } from "./identities.ts";
import { InMemoryEmailSender } from "./email.ts";
import { InMemoryRateLimiter } from "./rate-limit.ts";
import { SESSION_COOKIE_NAME, verifySession } from "./session.ts";
import { GOOGLE_START_LIMIT, GOOGLE_CALLBACK_LIMIT } from "./google-service.ts";
import { GoogleAuthService } from "./google-service.ts";
import { createGoogleAuthHandler } from "./google-http.ts";
import { MetricsRegistry } from "../../../packages/shared/observe/registry.ts";

const CLIENT_ID = "fake-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "test-only-client-secret";
const REDIRECT_URI = "http://localhost:3000/auth/google/callback";
const SESSION_SECRET = "google-routes-test-session-secret-aaaaaaaaaa";
/** The same fixed epoch-ms the fake IdP dates its tokens from. */
const NOW = 1_770_000_000_000;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fake Google TOKEN endpoint in front of the fake IdP.
 *
 * It enforces what Google enforces and nothing more: the code must be one it
 * issued, the PKCE `code_verifier` must hash (S256) to the challenge that was
 * sent at authorize time, and `redirect_uri` must be byte-identical. Only then
 * does it mint an ID token — bound to the nonce that authorize request carried.
 * That is what makes "the callback forgot the verifier" and "the callback
 * forgot the nonce" observable here rather than in production.
 */
class FakeGoogleServer {
  readonly idp: FakeGoogleIdp;
  /** Every request body the token endpoint received, verbatim and in order. */
  readonly tokenRequests: URLSearchParams[] = [];

  readonly #codes = new Map<
    string,
    { nonce: string; codeChallenge: string; overrides?: MintOverrides }
  >();
  #next = 1;

  constructor(idp: FakeGoogleIdp) {
    this.idp = idp;
  }

  /** "The user consented": mint a code bound to that authorize request. */
  issueCode(authorizeUrl: string, overrides?: MintOverrides): string {
    const url = new URL(authorizeUrl);
    const code = `google-code-${this.#next++}`;
    this.#codes.set(code, {
      nonce: url.searchParams.get("nonce") ?? "",
      codeChallenge: url.searchParams.get("code_challenge") ?? "",
      overrides,
    });
    return code;
  }

  readonly fetchImpl: typeof fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // Anything that is not the token endpoint is the IdP's business (JWKS).
    if (url !== GOOGLE_TOKEN_URL) return this.idp.fetchImpl(input as never, init);

    const body = new URLSearchParams(String(init?.body ?? ""));
    this.tokenRequests.push(body);

    const issued = this.#codes.get(body.get("code") ?? "");
    if (issued === undefined) return jsonResponse({ error: "invalid_grant" }, 400);
    if (body.get("redirect_uri") !== REDIRECT_URI) {
      return jsonResponse({ error: "redirect_uri_mismatch" }, 400);
    }
    const verifier = body.get("code_verifier") ?? "";
    if (verifier.length === 0 || codeChallengeS256(verifier) !== issued.codeChallenge) {
      return jsonResponse({ error: "invalid_grant" }, 400);
    }

    const idToken = this.idp.mint({
      claims: { nonce: issued.nonce, ...issued.overrides?.claims },
      omitClaims: issued.overrides?.omitClaims,
    });
    return jsonResponse({ access_token: "fake-access", id_token: idToken, token_type: "Bearer" }, 200);
  }) as typeof fetch;
}

function harness(opts: { configured?: boolean } = {}) {
  const idp = new FakeGoogleIdp({ clientId: CLIENT_ID, nowMs: NOW });
  const google = new FakeGoogleServer(idp);
  const userStore = new InMemoryUserStore();
  const identityStore = new InMemoryIdentityStore(userStore);
  const emailSender = new InMemoryEmailSender();
  const rateLimiter = new InMemoryRateLimiter();
  const registry = new MetricsRegistry();
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  let now = NOW;

  const provider =
    opts.configured === false
      ? undefined
      : new GoogleOAuthProvider({
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          redirectUri: REDIRECT_URI,
          fetchImpl: google.fetchImpl,
        });

  const service = new GoogleAuthService({
    provider,
    identityStore,
    userStore,
    emailSender,
    rateLimiter,
    sessionSecret: SESSION_SECRET,
    clock: () => now,
    metrics: registry,
    // Captured rather than printed: these are the SERVER-SIDE diagnostics, and a
    // test that asserts what is in them is worth more than a noisy suite.
    logger: { error: (message, fields) => logs.push({ message, fields }) },
  });

  return {
    idp,
    google,
    userStore,
    identityStore,
    emailSender,
    registry,
    logs,
    handler: createGoogleAuthHandler(service),
    advance(ms: number) {
      now += ms;
    },
  };
}

type Harness = ReturnType<typeof harness>;

function get(h: Harness, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return h.handler(new Request(`http://api.test${path}`, { headers }));
}

/** The `__Host-samo_oauth` Set-Cookie header on a response, or undefined. */
function stateSetCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`));
}

/** The raw signed value of the state cookie a response set. */
function stateCookieValue(res: Response): string {
  const header = stateSetCookie(res);
  if (header === undefined) throw new Error("response set no __Host-samo_oauth cookie");
  return header.slice(`${OAUTH_STATE_COOKIE_NAME}=`.length).split(";")[0];
}

/** The `samo_session` Set-Cookie header on a response, or undefined. */
function sessionSetCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
}

function cookieHeader(value: string): Record<string, string> {
  return { cookie: `${OAUTH_STATE_COOKIE_NAME}=${value}` };
}

/**
 * Walk the whole browser round trip: start → "Google" → callback.
 * Returns both responses plus the authorize URL, so a test can assert on any leg.
 */
async function roundTrip(
  h: Harness,
  opts: { returnTo?: string; overrides?: MintOverrides } = {},
): Promise<{ startRes: Response; authorizeUrl: string; callbackRes: Response }> {
  const startRes = await get(
    h,
    `/auth/google/start${opts.returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(opts.returnTo)}`}`,
  );
  const authorizeUrl = startRes.headers.get("location") ?? "";
  const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
  const code = h.google.issueCode(authorizeUrl, opts.overrides);
  const callbackRes = await get(
    h,
    `/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    cookieHeader(stateCookieValue(startRes)),
  );
  return { startRes, authorizeUrl, callbackRes };
}

// ─────────────────────────────────────────────────────────────────────────────
describe("GET /auth/providers — the sole gate on the Continue-with-Google button", () => {
  it("returns exactly {\"google\":true} when a Google provider is composed", async () => {
    const h = harness();
    const res = await get(h, "/auth/providers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ google: true });
  });

  it("returns exactly {\"google\":false} when no Google credentials are configured", async () => {
    const h = harness({ configured: false });
    const res = await get(h, "/auth/providers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ google: false });
  });

  it("sends cache-control: no-store so a cached answer cannot pin the button", async () => {
    const h = harness();
    const res = await get(h, "/auth/providers");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves GET only — POST /auth/providers is 404", async () => {
    const h = harness();
    const res = await h.handler(
      new Request("http://api.test/auth/providers", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("GET /auth/google/start — the authorize redirect", () => {
  it("302s to Google's authorize endpoint with the exact §5.1/S5-1 parameters", async () => {
    const h = harness();
    const res = await get(h, "/auth/google/start");
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location") ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTHORIZE_URL);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("access_type")).toBe("online");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("sets a __Host-samo_oauth cookie whose signed state equals the authorize URL's state", async () => {
    const h = harness();
    const res = await get(h, "/auth/google/start");
    const header = stateSetCookie(res);
    expect(header).toContain("Path=/");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Domain=");

    const claims = verifyOAuthState(stateCookieValue(res), SESSION_SECRET, NOW);
    expect(claims).not.toBeNull();
    const url = new URL(res.headers.get("location") ?? "");
    expect(claims!.state).toBe(url.searchParams.get("state")!);
    expect(claims!.nonce).toBe(url.searchParams.get("nonce")!);
    expect(claims!.iat).toBe(NOW);
    expect(claims!.v).toBe(1);
  });

  it("sends the S256 challenge of the verifier it kept, never the verifier itself", async () => {
    const h = harness();
    const res = await get(h, "/auth/google/start");
    const claims = verifyOAuthState(stateCookieValue(res), SESSION_SECRET, NOW)!;
    const url = new URL(res.headers.get("location") ?? "");
    expect(url.searchParams.get("code_challenge")).toBe(codeChallengeS256(claims.codeVerifier));
    expect(res.headers.get("location")).not.toContain(claims.codeVerifier);
  });

  it("mints a fresh state/nonce/verifier on every start", async () => {
    const h = harness();
    const a = verifyOAuthState(stateCookieValue(await get(h, "/auth/google/start")), SESSION_SECRET, NOW)!;
    const b = verifyOAuthState(stateCookieValue(await get(h, "/auth/google/start")), SESSION_SECRET, NOW)!;
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  it("carries an allowlisted returnTo (/settings) into the state cookie", async () => {
    const h = harness();
    const res = await get(h, "/auth/google/start?returnTo=%2Fsettings");
    expect(verifyOAuthState(stateCookieValue(res), SESSION_SECRET, NOW)!.returnTo).toBe("/settings");
  });

  it("rejects an off-site returnTo (https://evil.example) and stores /dashboard instead", async () => {
    const h = harness();
    const res = await get(h, "/auth/google/start?returnTo=https%3A%2F%2Fevil.example%2Fsteal");
    expect(verifyOAuthState(stateCookieValue(res), SESSION_SECRET, NOW)!.returnTo).toBe(DEFAULT_RETURN_TO);
  });

  it("rejects a protocol-relative returnTo (//evil.example) and stores /dashboard instead", async () => {
    const h = harness();
    const res = await get(h, "/auth/google/start?returnTo=%2F%2Fevil.example");
    expect(verifyOAuthState(stateCookieValue(res), SESSION_SECRET, NOW)!.returnTo).toBe(DEFAULT_RETURN_TO);
  });

  it("refuses with 302 /auth?error=SAMO-AUTH-010 and NO cookie when Google is unconfigured", async () => {
    const h = harness({ configured: false });
    const res = await get(h, "/auth/google/start");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth?error=SAMO-AUTH-010");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("302s to /auth?error=SAMO-AUTH-004 once one IP exceeds the per-hour start budget", async () => {
    const h = harness();
    const ip = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < GOOGLE_START_LIMIT; i++) {
      expect((await get(h, "/auth/google/start", ip)).headers.get("location")).toContain(
        GOOGLE_AUTHORIZE_URL,
      );
    }
    const blocked = await get(h, "/auth/google/start", ip);
    expect(blocked.status).toBe(302);
    expect(blocked.headers.get("location")).toBe("/auth?error=SAMO-AUTH-004");
    expect(blocked.headers.getSetCookie()).toEqual([]);
    // Independent per IP: a different caller is untouched.
    const other = await get(h, "/auth/google/start", { "cf-connecting-ip": "198.51.100.4" });
    expect(other.headers.get("location")).toContain(GOOGLE_AUTHORIZE_URL);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("GET /auth/google/callback — happy paths", () => {
  it("signs a NEW Google user in: one user, one identity, a session cookie, /dashboard", async () => {
    const h = harness();
    const { callbackRes } = await roundTrip(h);

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("location")).toBe(DEFAULT_RETURN_TO);

    expect(h.userStore.users.size).toBe(1);
    const user = h.userStore.users.get("alice@example.com")!;
    expect(user).toBeDefined();
    expect(h.identityStore.records).toHaveLength(1);
    expect(h.identityStore.records[0].provider).toBe("google");
    expect(h.identityStore.records[0].subject).toBe("117000000000000000001");
    expect(h.identityStore.records[0].userId).toBe(user.id);
    expect(h.identityStore.records[0].email).toBe("alice@example.com");

    const session = sessionSetCookie(callbackRes)!;
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Lax");
    const claims = verifySession(
      session.slice(`${SESSION_COOKIE_NAME}=`.length).split(";")[0],
      SESSION_SECRET,
      NOW,
    );
    expect(claims).toEqual({ userId: user.id, tenantId: user.tenantId, iat: NOW });
  });

  it("sends NO link-notification email on the new-user branch", async () => {
    const h = harness();
    await roundTrip(h);
    expect(h.emailSender.sentIdentityLinks).toEqual([]);
  });

  it("clears the state cookie on success, alongside the session cookie", async () => {
    const h = harness();
    const { callbackRes } = await roundTrip(h);
    expect(callbackRes.headers.getSetCookie()).toHaveLength(2);
    expect(stateSetCookie(callbackRes)).toBe(
      `${OAUTH_STATE_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    );
  });

  it("resolves a RETURNING identity by (provider, sub) even when Google's email changed", async () => {
    const h = harness();
    const first = await roundTrip(h);
    const user = h.userStore.users.get("alice@example.com")!;
    expect(first.callbackRes.status).toBe(302);

    // Same `sub`, brand-new address: identity must resolve WITHOUT consulting email.
    const second = await roundTrip(h, {
      overrides: { claims: { email: "alice.renamed@example.com" } },
    });
    expect(second.callbackRes.status).toBe(302);

    const claims = verifySession(
      sessionSetCookie(second.callbackRes)!
        .slice(`${SESSION_COOKIE_NAME}=`.length)
        .split(";")[0],
      SESSION_SECRET,
      NOW,
    );
    expect(claims).toEqual({ userId: user.id, tenantId: user.tenantId, iat: NOW });
    // No second user, no second tenant, no second identity row.
    expect(h.userStore.users.size).toBe(1);
    expect(h.identityStore.records).toHaveLength(1);
    expect(h.emailSender.sentIdentityLinks).toEqual([]);
  });

  it("links a first Google sign-in to an EXISTING magic-link user and emails them exactly once", async () => {
    const h = harness();
    const existing = await h.userStore.createOrLoadUser("alice@example.com");
    const { callbackRes } = await roundTrip(h);

    expect(callbackRes.status).toBe(302);
    expect(h.userStore.users.size).toBe(1);
    expect(h.identityStore.records).toHaveLength(1);
    expect(h.identityStore.records[0].userId).toBe(existing.id);
    expect(h.emailSender.sentIdentityLinks).toEqual([
      { to: "alice@example.com", provider: "google" },
    ]);

    const claims = verifySession(
      sessionSetCookie(callbackRes)!.slice(`${SESSION_COOKIE_NAME}=`.length).split(";")[0],
      SESSION_SECRET,
      NOW,
    );
    expect(claims).toEqual({ userId: existing.id, tenantId: existing.tenantId, iat: NOW });
  });

  it("notifies the address ON FILE, not the one the ID token asserted", async () => {
    const h = harness();
    // The account was created by magic link as `alice@example.com`; the Google
    // token asserts a differently-cased spelling of the same mailbox.
    const existing = await h.userStore.createOrLoadUser("alice@example.com");
    const { callbackRes } = await roundTrip(h, {
      overrides: { claims: { email: "ALICE@example.com" } },
    });
    expect(callbackRes.status).toBe(302);
    expect(h.identityStore.records[0].userId).toBe(existing.id);
    expect(h.emailSender.sentIdentityLinks).toEqual([
      { to: "alice@example.com", provider: "google" },
    ]);
  });

  it("emails the link notification ONLY on the first link, never on the next sign-in", async () => {
    const h = harness();
    await h.userStore.createOrLoadUser("alice@example.com");
    await roundTrip(h);
    await roundTrip(h);
    expect(h.emailSender.sentIdentityLinks).toHaveLength(1);
  });

  it("lands on the allowlisted returnTo the state cookie carried (/settings)", async () => {
    const h = harness();
    const { callbackRes } = await roundTrip(h, { returnTo: "/settings" });
    expect(callbackRes.headers.get("location")).toBe("/settings");
  });

  it("re-validates returnTo at the callback: a forged path in a validly-signed cookie falls back", async () => {
    const h = harness();
    const startRes = await get(h, "/auth/google/start");
    const authorizeUrl = startRes.headers.get("location")!;
    const original = verifyOAuthState(stateCookieValue(startRes), SESSION_SECRET, NOW)!;
    // An attacker who ever gets the signing key (or a future bug that widens the
    // start-side allowlist) must still not turn the callback into an open redirect.
    const forged = signOAuthState(
      { ...original, returnTo: "https://evil.example/steal" },
      SESSION_SECRET,
    );
    const code = h.google.issueCode(authorizeUrl);
    const res = await get(
      h,
      `/auth/google/callback?code=${code}&state=${encodeURIComponent(original.state)}`,
      cookieHeader(forged),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(DEFAULT_RETURN_TO);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("GET /auth/google/callback — state, PKCE and nonce failures", () => {
  it("SAMO-AUTH-007 with NO state cookie, and the token endpoint is never called", async () => {
    const h = harness();
    const startRes = await get(h, "/auth/google/start");
    const authorizeUrl = startRes.headers.get("location")!;
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const code = h.google.issueCode(authorizeUrl);

    const res = await get(h, `/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth?error=SAMO-AUTH-007");
    expect(h.google.tokenRequests).toEqual([]);
    expect(sessionSetCookie(res)).toBeUndefined();
  });

  it("SAMO-AUTH-007 on a TAMPERED cookie signature, and the token endpoint is never called", async () => {
    const h = harness();
    const startRes = await get(h, "/auth/google/start");
    const authorizeUrl = startRes.headers.get("location")!;
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const code = h.google.issueCode(authorizeUrl);

    // Flip the FIRST signature character, never the last: base64url's final
    // character of a 32-byte digest carries only 2 significant bits, so "A" and
    // "B" there decode to the SAME bytes and the forgery would verify.
    const [payload, sig] = stateCookieValue(startRes).split(".");
    const flipped = `${payload}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
    const res = await get(
      h,
      `/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`,
      cookieHeader(flipped),
    );
    expect(res.headers.get("location")).toBe("/auth?error=SAMO-AUTH-007");
    expect(h.google.tokenRequests).toEqual([]);
  });

  it("SAMO-AUTH-007 when ?state does not match the cookie, and the token endpoint is never called", async () => {
    const h = harness();
    const startRes = await get(h, "/auth/google/start");
    const authorizeUrl = startRes.headers.get("location")!;
    const code = h.google.issueCode(authorizeUrl);

    const res = await get(
      h,
      `/auth/google/callback?code=${code}&state=attacker-chosen-state`,
      cookieHeader(stateCookieValue(startRes)),
    );
    expect(res.headers.get("location")).toBe("/auth?error=SAMO-AUTH-007");
    expect(h.google.tokenRequests).toEqual([]);
  });

  it("SAMO-AUTH-007 with NO ?state at all (never 'skip the check when absent')", async () => {
    const h = harness();
    const startRes = await get(h, "/auth/google/start");
    const code = h.google.issueCode(startRes.headers.get("location")!);
    const res = await get(
      h,
      `/auth/google/callback?code=${code}`,
      cookieHeader(stateCookieValue(startRes)),
    );
    expect(res.headers.get("location")).toBe("/auth?error=SAMO-AUTH-007");
    expect(h.google.tokenRequests).toEqual([]);
  });

  it("SAMO-AUTH-007 once the state cookie is older than its 10-minute TTL", async () => {
    const h = harness();
    const startRes = await get(h, "/auth/google/start");
    const authorizeUrl = startRes.headers.get("location")!;
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const code = h.google.issueCode(authorizeUrl);

    h.advance(OAUTH_STATE_TTL_MS + 1);
    const res = await get(
      h,
      `/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`,
      cookieHeader(stateCookieValue(startRes)),
    );
    expect(res.headers.get("location")).toBe("/auth?error=SAMO-AUTH-007");
    expect(h.google.tokenRequests).toEqual([]);
  });

  it("clears the state cookie even when the callback rejects", async () => {
    const h = harness();
    const res = await get(h, "/auth/google/callback?code=x&state=y");
    expect(res.headers.getSetCookie()).toEqual([
      `${OAUTH_STATE_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    ]);
  });

  it("SAMO-AUTH-008 when the PKCE verifier does not match the challenge Google was sent", async () => {
    const h = harness();
    const startRes = await get(h, "/auth/google/start");
    const authorizeUrl = startRes.headers.get("location")!;
    const original = verifyOAuthState(stateCookieValue(startRes), SESSION_SECRET, NOW)!;
    const code = h.google.issueCode(authorizeUrl);

    // A validly-signed cookie carrying a DIFFERENT verifier: Google recomputes
    // S256 over what we send and refuses the exchange.
    const swapped = signOAuthState(
      { ...original, codeVerifier: "a-different-verifier-entirely" },
      SESSION_SECRET,
    );
    const res = await get(
      h,
      `/auth/google/callback?code=${code}&state=${encodeURIComponent(original.state)}`,
      cookieHeader(swapped),
    );
    expect(res.headers.get("location")).toBe("/auth?error=SAMO-AUTH-008");
    expect(h.google.tokenRequests).toHaveLength(1);
    expect(h.identityStore.records).toEqual([]);
    expect(h.userStore.users.size).toBe(0);
    expect(sessionSetCookie(res)).toBeUndefined();
  });

  it("sends the state cookie's OWN verifier, the code and the registered redirect_uri", async () => {
    const h = harness();
    const { startRes, authorizeUrl } = await roundTrip(h);
    const claims = verifyOAuthState(stateCookieValue(startRes), SESSION_SECRET, NOW)!;

    expect(h.google.tokenRequests).toHaveLength(1);
    const body = h.google.tokenRequests[0];
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("google-code-1");
    expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(body.get("client_id")).toBe(CLIENT_ID);
    // The verifier is the one the cookie carried, and it hashes to the challenge
    // that was actually sent to Google.
    expect(body.get("code_verifier")).toBe(claims.codeVerifier);
    expect(codeChallengeS256(body.get("code_verifier") ?? "")).toBe(
      new URL(authorizeUrl).searchParams.get("code_challenge") ?? "",
    );
  });

  it("SAMO-AUTH-008 when the ID token's nonce is not the one the state cookie carried", async () => {
    const h = harness();
    const { callbackRes } = await roundTrip(h, {
      overrides: { claims: { nonce: "some-other-nonce" } },
    });
    expect(callbackRes.headers.get("location")).toBe("/auth?error=SAMO-AUTH-008");
    expect(h.identityStore.records).toEqual([]);
    expect(h.userStore.users.size).toBe(0);
    expect(sessionSetCookie(callbackRes)).toBeUndefined();
  });

  it("SAMO-AUTH-008 when the ID token carries no nonce claim at all", async () => {
    const h = harness();
    const { callbackRes } = await roundTrip(h, { overrides: { omitClaims: ["nonce"] } });
    expect(callbackRes.headers.get("location")).toBe("/auth?error=SAMO-AUTH-008");
    expect(h.userStore.users.size).toBe(0);
  });

  it("SAMO-AUTH-008 when Google's token endpoint refuses the code", async () => {
    const h = harness();
    const startRes = await get(h, "/auth/google/start");
    const state = new URL(startRes.headers.get("location")!).searchParams.get("state")!;
    const res = await get(
      h,
      `/auth/google/callback?code=never-issued&state=${encodeURIComponent(state)}`,
      cookieHeader(stateCookieValue(startRes)),
    );
    expect(res.headers.get("location")).toBe("/auth?error=SAMO-AUTH-008");
  });

  it("302s to SAMO-AUTH-004 once one IP exceeds the per-hour CALLBACK budget", async () => {
    const h = harness();
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    const startRes = await get(h, "/auth/google/start", ip);
    const state = new URL(startRes.headers.get("location")!).searchParams.get("state")!;
    const cookie = { ...cookieHeader(stateCookieValue(startRes)), ...ip };
    const callback = () =>
      get(h, `/auth/google/callback?code=never-issued&state=${encodeURIComponent(state)}`, cookie);

    // The charge happens BEFORE the token exchange, so these all spend a slot.
    for (let i = 0; i < GOOGLE_CALLBACK_LIMIT; i++) {
      expect((await callback()).headers.get("location")).toBe("/auth?error=SAMO-AUTH-008");
    }
    expect((await callback()).headers.get("location")).toBe("/auth?error=SAMO-AUTH-004");
    // And the budget is its OWN: this IP can still start a fresh flow.
    expect((await get(h, "/auth/google/start", ip)).headers.get("location")).toContain(
      GOOGLE_AUTHORIZE_URL,
    );
  });

  it("logs the rejection reason server-side and NEVER the client secret", async () => {
    const h = harness();
    await roundTrip(h, { overrides: { claims: { nonce: "some-other-nonce" } } });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0].message).toBe("auth.google.callback: exchange rejected");
    expect(h.logs[0].fields).toEqual({
      reason: "id_token_rejected",
      detail: "google id token rejected: nonce_mismatch",
    });
    expect(JSON.stringify(h.logs)).not.toContain(CLIENT_SECRET);
  });

  it("SAMO-AUTH-008 when Google returns no code and no error (a protocol violation)", async () => {
    const h = harness();
    const startRes = await get(h, "/auth/google/start");
    const state = new URL(startRes.headers.get("location")!).searchParams.get("state")!;
    const res = await get(
      h,
      `/auth/google/callback?state=${encodeURIComponent(state)}`,
      cookieHeader(stateCookieValue(startRes)),
    );
    expect(res.headers.get("location")).toBe("/auth?error=SAMO-AUTH-008");
    expect(h.google.tokenRequests).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("GET /auth/google/callback — the email_verified gate (S5-1 item 4)", () => {
  const cases: Array<[string, unknown]> = [
    ["false", false],
    ['the string "true"', "true"],
    ["the number 1", 1],
    ["null", null],
  ];

  for (const [label, value] of cases) {
    it(`SAMO-AUTH-009 when email_verified is ${label}: no user, no identity, no cookie`, async () => {
      const h = harness();
      const { callbackRes } = await roundTrip(h, {
        overrides: { claims: { email_verified: value } },
      });
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get("location")).toBe("/auth?error=SAMO-AUTH-009");
      expect(h.userStore.users.size).toBe(0);
      expect(h.identityStore.records).toEqual([]);
      expect(sessionSetCookie(callbackRes)).toBeUndefined();
      expect(h.emailSender.sentIdentityLinks).toEqual([]);
    });
  }

  it("SAMO-AUTH-009 when email_verified is absent entirely", async () => {
    const h = harness();
    const { callbackRes } = await roundTrip(h, {
      overrides: { omitClaims: ["email_verified"] },
    });
    expect(callbackRes.headers.get("location")).toBe("/auth?error=SAMO-AUTH-009");
    expect(h.userStore.users.size).toBe(0);
    expect(h.identityStore.records).toEqual([]);
  });

  it("never squats an existing magic-link user's address on an unverified token", async () => {
    const h = harness();
    const existing = await h.userStore.createOrLoadUser("alice@example.com");
    const { callbackRes } = await roundTrip(h, {
      overrides: { claims: { email_verified: false } },
    });
    expect(callbackRes.headers.get("location")).toBe("/auth?error=SAMO-AUTH-009");
    expect(h.identityStore.records).toEqual([]);
    expect(h.emailSender.sentIdentityLinks).toEqual([]);
    expect(h.userStore.users.get("alice@example.com")!.id).toBe(existing.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("GET /auth/google/callback — Google-reported errors and unconfigured envs", () => {
  it("SAMO-AUTH-006 when the user cancels at Google's consent screen", async () => {
    const h = harness();
    const startRes = await get(h, "/auth/google/start");
    const state = new URL(startRes.headers.get("location")!).searchParams.get("state")!;
    const res = await get(
      h,
      `/auth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      cookieHeader(stateCookieValue(startRes)),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth?error=SAMO-AUTH-006");
    expect(h.google.tokenRequests).toEqual([]);
  });

  it("SAMO-AUTH-008 for any OTHER Google error, and never reflects Google's text", async () => {
    const h = harness();
    const startRes = await get(h, "/auth/google/start");
    const state = new URL(startRes.headers.get("location")!).searchParams.get("state")!;
    const res = await get(
      h,
      `/auth/google/callback?error=server_error&error_description=leaky%20detail&state=${encodeURIComponent(state)}`,
      cookieHeader(stateCookieValue(startRes)),
    );
    expect(res.headers.get("location")).toBe("/auth?error=SAMO-AUTH-008");
    expect(res.headers.get("location")).not.toContain("leaky");
  });

  it("SAMO-AUTH-010 on the callback of an environment with no Google credentials", async () => {
    const h = harness({ configured: false });
    const res = await get(h, "/auth/google/callback?code=x&state=y");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth?error=SAMO-AUTH-010");
  });

  it("404s any other path and any non-GET method on the Google routes", async () => {
    const h = harness();
    expect((await get(h, "/auth/google/other")).status).toBe(404);
    expect(
      (
        await h.handler(
          new Request("http://api.test/auth/google/start", { method: "POST" }),
        )
      ).status,
    ).toBe(404);
  });
});

/**
 * The three auth counters S5-1 item 7 named (issue #222), driven through the
 * REAL routes and the real fake-IdP round trip — not by calling the increment
 * methods directly, which would only prove the registry works.
 *
 * `auth_identity_linked_total` counts the S5-1 item 5 SILENT-LINK branch and
 * nothing else: link-to-existing only, never a new user, never a returning
 * signer. It is the metric behind "how often did we attach a Google account to
 * someone's existing tenant without asking", so counting anything else would
 * make it useless.
 */
describe("auth_google_* / auth_identity_linked_total counters — #222", () => {
  it("GET /auth/google/start increments auth_google_start_total exactly once", async () => {
    const h = harness();
    await get(h, "/auth/google/start");
    expect(h.registry.getScalar("auth_google_start_total")).toBe(1);
    expect(h.registry.renderPrometheus()).toContain("auth_google_start_total 1");
  });

  it("a successful callback increments auth_google_callback_total{result=\"ok\"}", async () => {
    const h = harness();
    const { callbackRes } = await roundTrip(h);
    expect(callbackRes.status).toBe(302);
    expect(h.registry.get("auth_google_callback_total", "ok")).toBe(1);
    expect(h.registry.renderPrometheus()).toContain(
      'auth_google_callback_total{result="ok"} 1',
    );
  });

  it("a failing callback is counted under its §5.16 error code, not under ok", async () => {
    const h = harness();
    // `email_verified` is not boolean true → SAMO-AUTH-009, the S5-1 item 4 gate.
    const { callbackRes } = await roundTrip(h, {
      overrides: { claims: { email_verified: false } },
    });
    expect(callbackRes.status).toBe(302);
    expect(h.registry.get("auth_google_callback_total", "SAMO-AUTH-009")).toBe(1);
    expect(h.registry.get("auth_google_callback_total", "ok")).toBe(0);
  });

  it("linking to an EXISTING user increments auth_identity_linked_total to 1", async () => {
    const h = harness();
    await h.userStore.createOrLoadUser("alice@example.com", "magic_link");
    await roundTrip(h);
    expect(h.registry.getScalar("auth_identity_linked_total")).toBe(1);
  });

  it("creating a NEW user leaves auth_identity_linked_total at exactly 0", async () => {
    const h = harness();
    const { callbackRes } = await roundTrip(h);
    expect(callbackRes.status).toBe(302);
    expect(h.userStore.users.size).toBe(1);
    expect(h.registry.getScalar("auth_identity_linked_total")).toBe(0);
    expect(h.registry.renderPrometheus()).toContain("auth_identity_linked_total 0");
  });

  it("a RETURNING Google signer does not increment auth_identity_linked_total again", async () => {
    const h = harness();
    await h.userStore.createOrLoadUser("alice@example.com", "magic_link");
    await roundTrip(h);
    await roundTrip(h);
    expect(h.registry.getScalar("auth_identity_linked_total")).toBe(1);
    expect(h.registry.get("auth_google_callback_total", "ok")).toBe(2);
  });
});

/**
 * `users.signup_method` at the service level (S5-1 item 7 / #222): the Google
 * callback stamps `google` on an account it CREATES, and the silent-link branch
 * leaves an existing account's `magic_link` untouched — the column records how
 * the account was created, not how its owner last signed in.
 */
describe("signup_method written by the Google callback — #222", () => {
  it("a NEW account created by the Google callback is stamped 'google'", async () => {
    const h = harness();
    await roundTrip(h);
    expect(h.userStore.signupMethods.get("alice@example.com")).toBe("google");
  });

  it("linking to an existing magic-link account leaves 'magic_link' in place", async () => {
    const h = harness();
    await h.userStore.createOrLoadUser("alice@example.com", "magic_link");
    await roundTrip(h);
    expect(h.userStore.signupMethods.get("alice@example.com")).toBe("magic_link");
  });
});
