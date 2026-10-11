/**
 * Google ID-token verification (RS256 + JWKS) — the negative suite IS the
 * deliverable (issue #209, PR 3).
 *
 * Every rejection below asserts an EXACT `{ok:false, code, reason}` triple, not
 * merely "it threw": a test that only checks "rejected" cannot tell an
 * algorithm-confusion reject apart from a typo that rejects everything.
 *
 * Tokens come from {@link FakeGoogleIdp}, which mints GENUINELY signed RS256
 * JWTs with a real 2048-bit RSA keypair and serves a real JWKS document through
 * the injected `fetch`. Nothing here hands the verifier a pre-parsed claims
 * object — the production verifier does the real crypto on every case.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  GOOGLE_JWKS_URL,
  GOOGLE_ID_TOKEN_ISSUERS,
  GOOGLE_ID_TOKEN_MAX_BYTES,
  ID_TOKEN_CLOCK_SKEW_MS,
  ID_TOKEN_MAX_IAT_AGE_MS,
  JWKS_MAX_CACHE_MS,
  JWKS_MIN_CACHE_MS,
  JWKS_REFRESH_COOLDOWN_MS,
  GoogleJwks,
  verifyGoogleIdToken,
  type VerifyGoogleIdTokenResult,
} from "./google-id-token.ts";
import { FakeGoogleIdp } from "../../../packages/test-fakes/google-oauth/index.ts";

const CLIENT_ID = "111111111111-samographprod.apps.googleusercontent.com";
const OTHER_CLIENT_ID = "222222222222-someoneelse.apps.googleusercontent.com";
/** Not a real secret — a fixed literal used only to forge an HS256 token. */
const CLIENT_SECRET = "GOCSPX-not-a-real-secret-fixture";
const NONCE = "n-0S6_WzA2Mj";
const SUB = "117000000000000000001";
const EMAIL = "alice@example.com";

/** A fixed whole-second epoch-MILLISECOND clock, so exp/iat maths is exact. */
const T0 = 1_770_000_000_000;
const T0_SEC = T0 / 1000;

let idp: FakeGoogleIdp;
let jwks: GoogleJwks;

function newIdp(opts: ConstructorParameters<typeof FakeGoogleIdp>[0] = {}): void {
  idp = new FakeGoogleIdp({ clientId: CLIENT_ID, nonce: NONCE, nowMs: T0, ...opts });
  jwks = new GoogleJwks({ fetchImpl: idp.fetchImpl });
}

function verify(
  token: string,
  over: { clientId?: string; expectedNonce?: string; nowMs?: number } = {},
): Promise<VerifyGoogleIdTokenResult> {
  return verifyGoogleIdToken(token, {
    clientId: over.clientId ?? CLIENT_ID,
    expectedNonce: over.expectedNonce ?? NONCE,
    jwks,
    nowMs: over.nowMs ?? T0,
  });
}

/** Every rejection in this module is SAMO-AUTH-008 plus a precise reason. */
function rejected(reason: string): VerifyGoogleIdTokenResult {
  return { ok: false, code: "SAMO-AUTH-008", reason: reason as never };
}

beforeEach(() => {
  newIdp();
});

describe("pinned constants", () => {
  test("the JWKS URL is the compile-time literal — no runtime discovery", () => {
    expect(GOOGLE_JWKS_URL).toBe("https://www.googleapis.com/oauth2/v3/certs");
  });

  test("the issuer allowlist is exactly the two literal Google issuers", () => {
    expect([...GOOGLE_ID_TOKEN_ISSUERS]).toEqual([
      "https://accounts.google.com",
      "accounts.google.com",
    ]);
  });

  test("bounds are the reviewed values", () => {
    expect(GOOGLE_ID_TOKEN_MAX_BYTES).toBe(8 * 1024);
    expect(ID_TOKEN_CLOCK_SKEW_MS).toBe(60_000);
    expect(ID_TOKEN_MAX_IAT_AGE_MS).toBe(5 * 60_000);
    expect(JWKS_MIN_CACHE_MS).toBe(5 * 60_000);
    expect(JWKS_MAX_CACHE_MS).toBe(24 * 60 * 60_000);
    expect(JWKS_REFRESH_COOLDOWN_MS).toBe(5 * 60_000);
  });
});

describe("happy path", () => {
  test("a genuinely signed RS256 token from the fake IdP verifies", async () => {
    const res = await verify(idp.mint());
    expect(res).toEqual({
      ok: true,
      identity: {
        provider: "google",
        subject: SUB,
        email: EMAIL,
        emailVerified: true,
      },
    });
  });

  test("both allowlisted issuer spellings are accepted", async () => {
    for (const iss of GOOGLE_ID_TOKEN_ISSUERS) {
      const res = await verify(idp.mint({ claims: { iss } }));
      expect(res.ok).toBe(true);
    }
  });

  test("aud as an ARRAY containing our client id is accepted", async () => {
    const res = await verify(
      idp.mint({ claims: { aud: [OTHER_CLIENT_ID, CLIENT_ID] } }),
    );
    expect(res.ok).toBe(true);
  });

  test("azp is optional — a token with no azp claim is accepted", async () => {
    const res = await verify(idp.mint({ omitClaims: ["azp"] }));
    expect(res.ok).toBe(true);
  });

  /**
   * THE UNIT TRAP. JWT `exp`/`iat` are SECONDS; `nowMs` is MILLISECONDS. A
   * verifier that forgets the ×1000 sees exp ≈ 1.77e9 ms (the year 1970) and
   * rejects this token as ~56 years expired, so `ok:true` here is a direct
   * assertion that the conversion happens exactly once.
   */
  test("exp/iat are read as SECONDS against a MILLISECOND clock", async () => {
    const res = await verify(
      idp.mint({ claims: { iat: T0_SEC, exp: T0_SEC + 3600 } }),
    );
    expect(res.ok).toBe(true);
  });
});

describe("structural bounds run BEFORE any crypto or network", () => {
  test("a token larger than 8KB rejects with zero JWKS fetches", async () => {
    const huge = idp.mint({ claims: { junk: "x".repeat(9000) } });
    expect(Buffer.byteLength(huge, "utf8")).toBeGreaterThan(GOOGLE_ID_TOKEN_MAX_BYTES);

    expect(await verify(huge)).toEqual(rejected("token_too_large"));
    expect(idp.fetchCount).toBe(0);
  });

  test("a 2-segment token rejects with zero JWKS fetches", async () => {
    const twoSegments = idp.mint().split(".").slice(0, 2).join(".");

    expect(await verify(twoSegments)).toEqual(rejected("malformed_token"));
    expect(idp.fetchCount).toBe(0);
  });

  test("a 4-segment token (JWE-shaped) rejects with zero JWKS fetches", async () => {
    expect(await verify(`${idp.mint()}.extra`)).toEqual(rejected("malformed_token"));
    expect(idp.fetchCount).toBe(0);
  });

  test("an empty token rejects with zero JWKS fetches", async () => {
    expect(await verify("")).toEqual(rejected("malformed_token"));
    expect(idp.fetchCount).toBe(0);
  });

  test("an undecodable header rejects with zero JWKS fetches", async () => {
    const parts = idp.mint().split(".");
    const bad = [Buffer.from("not json", "utf8").toString("base64url"), parts[1], parts[2]].join(".");

    expect(await verify(bad)).toEqual(rejected("bad_header"));
    expect(idp.fetchCount).toBe(0);
  });
});

describe("algorithm confusion — alg is pinned BEFORE any key lookup", () => {
  test('alg:"none" rejects, and never reaches the JWKS', async () => {
    expect(await verify(idp.mintAlgNone())).toEqual(rejected("alg_not_rs256"));
    expect(idp.fetchCount).toBe(0);
  });

  test("HS256 forged with the CLIENT SECRET as the HMAC key rejects", async () => {
    const forged = idp.mintHs256(CLIENT_SECRET);
    // Sanity: the forgery is internally consistent — it is a real HS256 JWT.
    const [h, p, s] = forged.split(".");
    const mac = createHmac("sha256", CLIENT_SECRET).update(`${h}.${p}`).digest("base64url");
    expect(s).toBe(mac);

    expect(await verify(forged)).toEqual(rejected("alg_not_rs256"));
    expect(idp.fetchCount).toBe(0);
  });

  test("HS256 forged with the RSA PUBLIC MODULUS as the HMAC key rejects", async () => {
    const forged = idp.mintHs256(idp.publicModulusBytes());
    expect(await verify(forged)).toEqual(rejected("alg_not_rs256"));
    expect(idp.fetchCount).toBe(0);
  });

  test("a downgraded RSA alg (RS384 in the header) rejects", async () => {
    expect(await verify(idp.mint({ header: { alg: "RS384" } }))).toEqual(
      rejected("alg_not_rs256"),
    );
    expect(idp.fetchCount).toBe(0);
  });

  test("a header with no alg at all rejects", async () => {
    expect(await verify(idp.mint({ omitHeader: ["alg"] }))).toEqual(
      rejected("alg_not_rs256"),
    );
    expect(idp.fetchCount).toBe(0);
  });

  test("a header with no kid rejects (after the alg pin)", async () => {
    expect(await verify(idp.mint({ omitHeader: ["kid"] }))).toEqual(
      rejected("missing_kid"),
    );
    expect(idp.fetchCount).toBe(0);
  });
});

describe("signature", () => {
  test("a tampered payload with a structurally valid token rejects", async () => {
    const tampered = idp.tamperPayload(idp.mint(), { email: "attacker@evil.tld" });
    expect(tampered.split(".").length).toBe(3);

    expect(await verify(tampered)).toEqual(rejected("bad_signature"));
  });

  test("a valid signature from a DIFFERENT 2048-bit keypair under the same kid rejects", async () => {
    expect(await verify(idp.mintWithForeignKey())).toEqual(rejected("bad_signature"));
  });

  test("a garbage signature segment rejects", async () => {
    const [h, p] = idp.mint().split(".");
    expect(await verify(`${h}.${p}.bm90YXNpZ25hdHVyZQ`)).toEqual(rejected("bad_signature"));
  });

  test("an undecodable payload behind a valid signature rejects", async () => {
    expect(await verify(idp.mintRawPayload("not json"))).toEqual(rejected("bad_payload"));
  });

  /**
   * These two pin "verified over the EXACT received bytes". Both tokens are
   * legitimately signed but NON-CANONICALLY encoded (whitespace inside the JSON,
   * so `base64url(JSON.stringify(JSON.parse(seg)))` !== `seg`). A verifier that
   * re-serialized the decoded header/payload and hashed that instead would
   * compute a different signing input and reject a perfectly good Google token —
   * a canonicalization gap that is a false-reject today and an accept-what-we-
   * did-not-verify bug the moment the two encodings diverge the other way.
   */
  test("a non-canonically encoded HEADER still verifies (received bytes, not re-serialized)", async () => {
    const raw = '{"alg":"RS256",  "kid":"fake-google-kid-1",   "typ":"JWT"}';
    expect(Buffer.from(raw, "utf8").toString("base64url")).not.toBe(
      Buffer.from(JSON.stringify(JSON.parse(raw)), "utf8").toString("base64url"),
    );

    expect((await verify(idp.mintRawHeader(raw))).ok).toBe(true);
  });

  test("a non-canonically encoded PAYLOAD still verifies (received bytes, not re-serialized)", async () => {
    const raw = JSON.stringify(idp.defaultClaims(), null, 2);
    expect(raw).not.toBe(JSON.stringify(JSON.parse(raw)));

    expect((await verify(idp.mintRawPayload(raw))).ok).toBe(true);
  });
});

describe("key selection", () => {
  test("an unknown kid rejects", async () => {
    expect(await verify(idp.mint({ header: { kid: "no-such-kid" } }))).toEqual(
      rejected("unknown_kid"),
    );
  });

  test("a 1024-bit key is rejected even with a VALID signature", async () => {
    newIdp({ modulusLength: 1024 });
    const token = idp.mint();
    // The signature really is valid for the published key — only the modulus is short.
    expect(idp.publicModulusBytes().length).toBe(128);

    expect(await verify(token)).toEqual(rejected("key_unusable"));
  });

  test('a JWKS key marked use:"enc" is rejected', async () => {
    newIdp({ jwkOverrides: { use: "enc" } });
    expect(await verify(idp.mint())).toEqual(rejected("key_unusable"));
  });

  test('a JWKS key marked alg:"RS384" is rejected', async () => {
    newIdp({ jwkOverrides: { alg: "RS384" } });
    expect(await verify(idp.mint())).toEqual(rejected("key_unusable"));
  });

  test('a JWKS key with kty:"oct" is rejected', async () => {
    newIdp({ jwkOverrides: { kty: "oct" } });
    expect(await verify(idp.mint())).toEqual(rejected("key_unusable"));
  });

  test('a JWKS key with use:"sig" and no alg is accepted', async () => {
    newIdp({ jwkOverrides: { use: "sig", alg: undefined } });
    expect((await verify(idp.mint())).ok).toBe(true);
  });
});

describe("iss — exact membership, never a prefix or suffix match", () => {
  test('"https://accounts.google.com.evil.tld" rejects', async () => {
    const res = await verify(
      idp.mint({ claims: { iss: "https://accounts.google.com.evil.tld" } }),
    );
    expect(res).toEqual(rejected("iss_not_allowed"));
  });

  test('"https://evil.tld/https://accounts.google.com" rejects', async () => {
    const res = await verify(
      idp.mint({ claims: { iss: "https://evil.tld/https://accounts.google.com" } }),
    );
    expect(res).toEqual(rejected("iss_not_allowed"));
  });

  test("a missing iss rejects", async () => {
    expect(await verify(idp.mint({ omitClaims: ["iss"] }))).toEqual(
      rejected("iss_not_allowed"),
    );
  });
});

describe("aud / azp", () => {
  test("aud for a different client id rejects", async () => {
    expect(await verify(idp.mint({ claims: { aud: OTHER_CLIENT_ID } }))).toEqual(
      rejected("aud_mismatch"),
    );
  });

  test("an aud ARRAY that does not contain our client id rejects", async () => {
    expect(
      await verify(idp.mint({ claims: { aud: [OTHER_CLIENT_ID, "third-party"] } })),
    ).toEqual(rejected("aud_mismatch"));
  });

  test("a missing aud rejects", async () => {
    expect(await verify(idp.mint({ omitClaims: ["aud"] }))).toEqual(
      rejected("aud_mismatch"),
    );
  });

  test("azp present but different rejects", async () => {
    expect(await verify(idp.mint({ claims: { azp: OTHER_CLIENT_ID } }))).toEqual(
      rejected("azp_mismatch"),
    );
  });
});

describe("exp / iat", () => {
  test("exp 61s in the past rejects (past the 60s skew)", async () => {
    expect(await verify(idp.mint({ claims: { exp: T0_SEC - 61 } }))).toEqual(
      rejected("expired"),
    );
  });

  test("exp 59s in the past is accepted (inside the 60s skew)", async () => {
    expect((await verify(idp.mint({ claims: { exp: T0_SEC - 59 } }))).ok).toBe(true);
  });

  test("exp exactly 60s in the past is accepted (the boundary is inclusive)", async () => {
    expect((await verify(idp.mint({ claims: { exp: T0_SEC - 60 } }))).ok).toBe(true);
  });

  test("a missing exp rejects", async () => {
    expect(await verify(idp.mint({ omitClaims: ["exp"] }))).toEqual(rejected("expired"));
  });

  test("iat 6 minutes in the FUTURE rejects", async () => {
    expect(await verify(idp.mint({ claims: { iat: T0_SEC + 360 } }))).toEqual(
      rejected("iat_not_fresh"),
    );
  });

  test("iat 10 minutes in the past rejects (freshness window is 5 min)", async () => {
    expect(await verify(idp.mint({ claims: { iat: T0_SEC - 600 } }))).toEqual(
      rejected("iat_not_fresh"),
    );
  });

  test("iat 4 minutes in the past is accepted", async () => {
    expect((await verify(idp.mint({ claims: { iat: T0_SEC - 240 } }))).ok).toBe(true);
  });

  test("a missing iat rejects", async () => {
    expect(await verify(idp.mint({ omitClaims: ["iat"] }))).toEqual(
      rejected("iat_not_fresh"),
    );
  });
});

describe("nonce — a MISSING nonce REJECTS, it is never skipped", () => {
  test("no nonce claim at all rejects", async () => {
    expect(await verify(idp.mint({ omitClaims: ["nonce"] }))).toEqual(
      rejected("nonce_missing"),
    );
  });

  test("an empty-string nonce rejects", async () => {
    expect(await verify(idp.mint({ claims: { nonce: "" } }))).toEqual(
      rejected("nonce_missing"),
    );
  });

  test("a mismatched nonce rejects", async () => {
    expect(await verify(idp.mint({ claims: { nonce: "someone-elses-nonce" } }))).toEqual(
      rejected("nonce_mismatch"),
    );
  });

  test("a matching nonce is accepted", async () => {
    expect((await verify(idp.mint({ claims: { nonce: NONCE } }))).ok).toBe(true);
  });

  test("an EMPTY expected nonce fails closed against an empty token nonce", async () => {
    const res = await verify(idp.mint({ claims: { nonce: "" } }), { expectedNonce: "" });
    expect(res).toEqual(rejected("nonce_missing"));
  });

  test("a nonce that is a PREFIX of the expected one rejects", async () => {
    expect(await verify(idp.mint({ claims: { nonce: NONCE.slice(0, -1) } }))).toEqual(
      rejected("nonce_mismatch"),
    );
  });
});

describe("sub / email", () => {
  test("an empty sub rejects", async () => {
    expect(await verify(idp.mint({ claims: { sub: "" } }))).toEqual(rejected("sub_invalid"));
  });

  test("a sub longer than 255 chars rejects", async () => {
    expect(await verify(idp.mint({ claims: { sub: "9".repeat(256) } }))).toEqual(
      rejected("sub_invalid"),
    );
  });

  test("a sub of exactly 255 chars is accepted", async () => {
    const res = await verify(idp.mint({ claims: { sub: "9".repeat(255) } }));
    expect(res.ok).toBe(true);
  });

  test("a missing email rejects", async () => {
    expect(await verify(idp.mint({ omitClaims: ["email"] }))).toEqual(
      rejected("email_missing"),
    );
  });
});

describe("email_verified is REPORTED, never enforced here", () => {
  test("email_verified:false still verifies, reported as false", async () => {
    const res = await verify(idp.mint({ claims: { email_verified: false } }));
    expect(res).toEqual({
      ok: true,
      identity: { provider: "google", subject: SUB, email: EMAIL, emailVerified: false },
    });
  });

  test('the STRING "true" is reported as false (boolean-strict)', async () => {
    const res = await verify(idp.mint({ claims: { email_verified: "true" } }));
    expect(res.ok && res.identity.emailVerified).toBe(false);
  });

  test("the NUMBER 1 is reported as false (boolean-strict)", async () => {
    const res = await verify(idp.mint({ claims: { email_verified: 1 } }));
    expect(res.ok && res.identity.emailVerified).toBe(false);
  });

  test("an absent email_verified is reported as false", async () => {
    const res = await verify(idp.mint({ omitClaims: ["email_verified"] }));
    expect(res.ok && res.identity.emailVerified).toBe(false);
  });
});

describe("JWKS caching, cooldown, single-flight and serve-stale", () => {
  test("the fetch goes to the pinned literal URL", async () => {
    await verify(idp.mint());
    expect(idp.requestedUrls).toEqual([GOOGLE_JWKS_URL]);
  });

  test("two verifies with the same kid issue exactly ONE fetch", async () => {
    expect((await verify(idp.mint())).ok).toBe(true);
    expect((await verify(idp.mint())).ok).toBe(true);
    expect(idp.fetchCount).toBe(1);
  });

  test("N concurrent cold-cache verifies issue exactly ONE fetch (single-flight)", async () => {
    newIdp({ fetchDelayMs: 15 });
    const tokens = [idp.mint(), idp.mint(), idp.mint(), idp.mint(), idp.mint()];
    const results = await Promise.all(tokens.map((t) => verify(t)));

    expect(results.every((r) => r.ok)).toBe(true);
    expect(idp.fetchCount).toBe(1);
  });

  test("an unknown kid forces exactly ONE refresh, and a second is suppressed for the cooldown", async () => {
    newIdp({ cacheControl: "public, max-age=86400" });

    expect((await verify(idp.mint())).ok).toBe(true);
    expect(idp.fetchCount).toBe(1);

    // Cache is fresh but has no such kid → one FORCED refresh.
    expect(await verify(idp.mint({ header: { kid: "rotated-1" } }))).toEqual(
      rejected("unknown_kid"),
    );
    expect(idp.fetchCount).toBe(2);

    // Inside the 5-minute cooldown: NO further network traffic.
    expect(
      await verify(idp.mint({ header: { kid: "rotated-2" } }), {
        nowMs: T0 + JWKS_REFRESH_COOLDOWN_MS - 1,
      }),
    ).toEqual(rejected("unknown_kid"));
    expect(idp.fetchCount).toBe(2);

    // Cooldown elapsed → one more forced refresh is allowed.
    expect(
      await verify(idp.mint({ header: { kid: "rotated-3" } }), {
        nowMs: T0 + JWKS_REFRESH_COOLDOWN_MS,
      }),
    ).toEqual(rejected("unknown_kid"));
    expect(idp.fetchCount).toBe(3);
  });

  test("an expired cache plus a FAILING fetch still verifies a previously-known kid (serve-stale)", async () => {
    newIdp({ cacheControl: "public, max-age=1" }); // floored to 5 min
    expect((await verify(idp.mint())).ok).toBe(true);
    expect(idp.fetchCount).toBe(1);

    idp.failFetches("connect ECONNREFUSED");

    const stale = await verify(
      idp.mint({ claims: { iat: T0_SEC + 600, exp: T0_SEC + 4200 } }),
      { nowMs: T0 + 10 * 60_000 },
    );
    expect(stale.ok).toBe(true);
    expect(idp.fetchCount).toBe(2); // it TRIED, then served the stale key
  });

  test("a failed fetch backs off — an immediate retry does not re-hit the network", async () => {
    newIdp({ cacheControl: "public, max-age=1" });
    expect((await verify(idp.mint())).ok).toBe(true);
    idp.failFetches("connect ECONNREFUSED");

    const at = T0 + 10 * 60_000;
    const fresh = { iat: T0_SEC + 600, exp: T0_SEC + 4200 };
    await verify(idp.mint({ claims: fresh }), { nowMs: at });
    expect(idp.fetchCount).toBe(2);

    await verify(idp.mint({ claims: fresh }), { nowMs: at + 1 });
    await verify(idp.mint({ claims: fresh }), { nowMs: at + 29_999 });
    expect(idp.fetchCount).toBe(2);

    await verify(idp.mint({ claims: fresh }), { nowMs: at + 30_000 });
    expect(idp.fetchCount).toBe(3);
  });

  test("a cold cache plus a failing fetch rejects as unknown_kid", async () => {
    idp.failFetches("connect ECONNREFUSED");
    expect(await verify(idp.mint())).toEqual(rejected("unknown_kid"));
  });

  test("Cache-Control max-age below the floor is raised to 5 minutes", async () => {
    newIdp({ cacheControl: "public, max-age=1" });

    expect((await verify(idp.mint())).ok).toBe(true);
    expect(idp.fetchCount).toBe(1);

    await verify(idp.mint(), { nowMs: T0 + JWKS_MIN_CACHE_MS - 1 });
    expect(idp.fetchCount).toBe(1);

    await verify(idp.mint({ claims: { iat: T0_SEC + 300, exp: T0_SEC + 3900 } }), {
      nowMs: T0 + JWKS_MIN_CACHE_MS,
    });
    expect(idp.fetchCount).toBe(2);
  });

  test("Cache-Control max-age above the ceiling is capped at 24 hours", async () => {
    newIdp({ cacheControl: "public, max-age=999999999" });

    expect((await verify(idp.mint())).ok).toBe(true);
    await verify(idp.mint(), { nowMs: T0 + JWKS_MAX_CACHE_MS - 1 });
    expect(idp.fetchCount).toBe(1);

    await verify(idp.mint(), { nowMs: T0 + JWKS_MAX_CACHE_MS });
    expect(idp.fetchCount).toBe(2);
  });

  test("a JWKS with no Cache-Control is cached for the 5-minute floor", async () => {
    newIdp({ cacheControl: null });

    expect((await verify(idp.mint())).ok).toBe(true);
    await verify(idp.mint(), { nowMs: T0 + JWKS_MIN_CACHE_MS - 1 });
    expect(idp.fetchCount).toBe(1);
  });

  test("a JWKS document with more than 20 keys is rejected wholesale", async () => {
    newIdp({ padKeys: 20 }); // 20 filler keys + the real one = 21
    expect(await verify(idp.mint())).toEqual(rejected("unknown_kid"));
  });

  test("a JWKS document exactly at the 20-key cap is accepted", async () => {
    newIdp({ padKeys: 19 });
    expect((await verify(idp.mint())).ok).toBe(true);
  });

  test("a JWKS response body over 128KB is rejected wholesale", async () => {
    newIdp({ padBodyBytes: 200_000 });
    expect(await verify(idp.mint())).toEqual(rejected("unknown_kid"));
  });

  test("a non-200 JWKS response is rejected wholesale", async () => {
    newIdp({ status: 500 });
    expect(await verify(idp.mint())).toEqual(rejected("unknown_kid"));
  });

  test("a JWKS body that is not JSON is rejected wholesale", async () => {
    newIdp({ rawBody: "<html>proxy error</html>" });
    expect(await verify(idp.mint())).toEqual(rejected("unknown_kid"));
  });
});
