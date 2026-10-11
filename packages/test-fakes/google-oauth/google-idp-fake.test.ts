/**
 * The fake IdP's own contract.
 *
 * These assertions deliberately do NOT go through `verifyGoogleIdToken` — they
 * check the fake with raw `node:crypto`, so "the tokens are genuinely signed" is
 * established independently of the code under test. If the fake ever degrades
 * into handing back a pre-parsed claims object, or a signature that is not a
 * real RSASSA-PKCS1-v1_5 over the received bytes, this file goes red and the
 * whole google-id-token suite is revealed as vacuous.
 */
import { describe, expect, test } from "bun:test";
import { createHmac, createPublicKey, createVerify } from "node:crypto";
import {
  FAKE_GOOGLE_EMAIL,
  FAKE_GOOGLE_KID,
  FAKE_GOOGLE_SUB,
  FakeGoogleIdp,
  GOOGLE_JWKS_URL,
} from "./index.ts";
import { GoogleCalendarOAuth, GOOGLE_CALENDAR_SCOPE } from "../../../apps/app-api/calendar/google-calendar-oauth.ts";
import { codeChallengeS256 } from "../../../apps/app-api/auth/oauth-state.ts";

const T0 = 1_770_000_000_000;

function decode(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

describe("FakeGoogleIdp mints REAL RS256 tokens", () => {
  test("the signature is a genuine RSASSA-PKCS1-v1_5 over the received bytes", () => {
    const idp = new FakeGoogleIdp({ nowMs: T0 });
    const token = idp.mint();
    const [headerB64, payloadB64, sigB64] = token.split(".");
    expect(token.split(".").length).toBe(3);

    const publicKey = createPublicKey({ key: idp.publicJwk() as never, format: "jwk" });
    const verified = createVerify("RSA-SHA256")
      .update(`${headerB64}.${payloadB64}`)
      .verify(publicKey, Buffer.from(String(sigB64), "base64url"));

    expect(verified).toBe(true);
    expect(Buffer.from(String(sigB64), "base64url").length).toBe(256);
  });

  test("the header and claims are the real Google shape", () => {
    const idp = new FakeGoogleIdp({ nowMs: T0, clientId: "cid", nonce: "nnn" });
    const [headerB64, payloadB64] = idp.mint().split(".");

    expect(decode(String(headerB64))).toEqual({
      alg: "RS256",
      kid: FAKE_GOOGLE_KID,
      typ: "JWT",
    });
    expect(decode(String(payloadB64))).toEqual({
      iss: "https://accounts.google.com",
      azp: "cid",
      aud: "cid",
      sub: FAKE_GOOGLE_SUB,
      email: FAKE_GOOGLE_EMAIL,
      email_verified: true,
      nonce: "nnn",
      iat: T0 / 1000,
      exp: T0 / 1000 + 3600,
    });
  });

  test("a foreign-key token does NOT verify against the published key", () => {
    const idp = new FakeGoogleIdp({ nowMs: T0 });
    const [headerB64, payloadB64, sigB64] = idp.mintWithForeignKey().split(".");

    const publicKey = createPublicKey({ key: idp.publicJwk() as never, format: "jwk" });
    const verified = createVerify("RSA-SHA256")
      .update(`${headerB64}.${payloadB64}`)
      .verify(publicKey, Buffer.from(String(sigB64), "base64url"));

    expect(verified).toBe(false);
  });

  test("mintAlgNone drops the signature entirely", () => {
    const idp = new FakeGoogleIdp({ nowMs: T0 });
    const token = idp.mintAlgNone();
    const parts = token.split(".");

    expect(parts.length).toBe(3);
    expect(parts[2]).toBe("");
    expect(decode(String(parts[0])).alg).toBe("none");
  });

  test("mintHs256 produces a real HMAC under the supplied key", () => {
    const idp = new FakeGoogleIdp({ nowMs: T0 });
    const [headerB64, payloadB64, sigB64] = idp.mintHs256("shhh").split(".");

    expect(decode(String(headerB64)).alg).toBe("HS256");
    expect(sigB64).toBe(
      createHmac("sha256", "shhh").update(`${headerB64}.${payloadB64}`).digest("base64url"),
    );
  });

  test("tamperPayload rewrites claims but keeps the original signature", () => {
    const idp = new FakeGoogleIdp({ nowMs: T0 });
    const token = idp.mint();
    const tampered = idp.tamperPayload(token, { email: "attacker@evil.tld" });

    expect(tampered.split(".")[0]).toBe(String(token.split(".")[0]));
    expect(tampered.split(".")[2]).toBe(String(token.split(".")[2]));
    expect(decode(String(tampered.split(".")[1])).email).toBe("attacker@evil.tld");
  });

  test("a 1024-bit IdP publishes a 128-byte modulus", () => {
    const idp = new FakeGoogleIdp({ modulusLength: 1024 });
    expect(idp.publicModulusBytes().length).toBe(128);
  });
});

describe("FakeGoogleIdp Calendar grants", () => {
  test("captures offline consent, issues refresh tokens, refreshes, and records revocation", async () => {
    const idp = new FakeGoogleIdp();
    const oauth = new GoogleCalendarOAuth({ clientId: idp.clientId, clientSecret: "secret", redirectUri: "http://localhost:3000/calendar/connect/callback", fetchImpl: idp.fetchImpl });
    const authorizationUrl = oauth.authorizeUrl({ state: "state", codeChallenge: codeChallengeS256("verifier") });
    const grant = idp.authorize(authorizationUrl);
    expect(idp.authorizationRequests[0]).toEqual({ scope: [GOOGLE_CALENDAR_SCOPE], accessType: "offline", includeGrantedScopes: "true", prompt: "consent", redirectUri: "http://localhost:3000/calendar/connect/callback", state: "state" });
    const exchanged = await oauth.exchangeCode({ code: grant.code, codeVerifier: "verifier" });
    expect(exchanged.ok).toBe(true);
    if (!exchanged.ok) return;
    const refreshed = await idp.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: exchanged.refreshToken }).toString(),
    });
    expect(refreshed.status).toBe(200);
    idp.invalidateRefreshToken(exchanged.refreshToken);
    const invalid = await idp.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: exchanged.refreshToken }).toString(),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_grant" });
    expect(await oauth.revoke(exchanged.refreshToken)).toBe(true);
    expect(idp.revokedTokens).toEqual([exchanged.refreshToken]);
  });

  test("can omit refresh_token and reject invalid PKCE", async () => {
    const idp = new FakeGoogleIdp({ omitRefreshToken: true });
    const oauth = new GoogleCalendarOAuth({ clientId: idp.clientId, clientSecret: "secret", redirectUri: "http://localhost:3000/calendar/connect/callback", fetchImpl: idp.fetchImpl });
    const omitted = idp.authorize(oauth.authorizeUrl({ state: "s", codeChallenge: codeChallengeS256("right") }));
    expect((await oauth.exchangeCode({ code: omitted.code, codeVerifier: "right" })).ok).toBe(false);
    const wrong = idp.authorize(oauth.authorizeUrl({ state: "s2", codeChallenge: codeChallengeS256("right") }));
    expect((await oauth.exchangeCode({ code: wrong.code, codeVerifier: "wrong" })).ok).toBe(false);
  });
});

describe("FakeGoogleIdp serves a real JWKS over the injected fetch", () => {
  test("the pinned production URL returns a parseable JWKS", async () => {
    const idp = new FakeGoogleIdp({ nowMs: T0 });
    const res = await idp.fetchImpl(GOOGLE_JWKS_URL);
    const body = (await res.json()) as { keys: Record<string, unknown>[] };

    expect(res.status).toBe(200);
    expect(body.keys.length).toBe(1);
    expect(body.keys[0]).toEqual(idp.publicJwk());
    expect(String(body.keys[0]?.kty)).toBe("RSA");
    expect(Buffer.from(String(body.keys[0]?.n), "base64url").length).toBe(256);
    expect(idp.fetchCount).toBe(1);
  });

  test("any other URL 404s and is not counted as a JWKS fetch", async () => {
    const idp = new FakeGoogleIdp();
    const res = await idp.fetchImpl("https://accounts.google.com/.well-known/openid-configuration");

    expect(res.status).toBe(404);
    expect(idp.fetchCount).toBe(0);
    expect(idp.requestedUrls).toEqual([
      "https://accounts.google.com/.well-known/openid-configuration",
    ]);
  });

  test("failFetches makes the transport reject, and the attempt is still counted", async () => {
    const idp = new FakeGoogleIdp();
    idp.failFetches("connect ECONNREFUSED");

    await expect(idp.fetchImpl(GOOGLE_JWKS_URL)).rejects.toThrow("connect ECONNREFUSED");
    expect(idp.fetchCount).toBe(1);

    idp.succeedFetches();
    expect((await idp.fetchImpl(GOOGLE_JWKS_URL)).status).toBe(200);
  });

  test("padKeys grows the document and jwkOverrides can remove a field", async () => {
    const idp = new FakeGoogleIdp({ padKeys: 3, jwkOverrides: { alg: undefined } });
    const body = (await (await idp.fetchImpl(GOOGLE_JWKS_URL)).json()) as {
      keys: Record<string, unknown>[];
    };

    expect(body.keys.length).toBe(4);
    expect("alg" in (body.keys[0] ?? {})).toBe(false);
  });
});
