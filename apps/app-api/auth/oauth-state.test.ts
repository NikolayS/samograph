import { describe, it, expect } from "bun:test";
import {
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_MS,
  OAUTH_STATE_PURPOSE,
  DEFAULT_RETURN_TO,
  type OAuthStateClaims,
  signOAuthState,
  verifyOAuthState,
  verifyOAuthStateForCallback,
  buildOAuthStateCookie,
  buildClearedOAuthStateCookie,
  issueOAuthStateCookie,
  readOAuthStateCookie,
  codeChallengeS256,
  validateReturnTo,
} from "./oauth-state.ts";
import { signSession, verifySession } from "./session.ts";
import { base64url, hmacSha256 } from "./crypto.ts";

const SECRET = "session-secret-xyz";
const T0 = 1_900_000_000_000; // fixed reference clock (2030-03-17)

const stateClaims = (over: Partial<OAuthStateClaims> = {}): OAuthStateClaims => ({
  v: 1,
  state: "s1",
  nonce: "n1",
  codeVerifier: "cv1",
  returnTo: "/dashboard",
  iat: T0,
  ...over,
});

/** Hand-sign an ARBITRARY payload object under the state purpose prefix. */
function signRaw(payload: unknown, secret = SECRET): string {
  const payloadB64 = base64url(JSON.stringify(payload));
  return `${payloadB64}.${base64url(hmacSha256(secret, OAUTH_STATE_PURPOSE + payloadB64))}`;
}

/**
 * Run `fn` with `JSON.parse` counted. The ORDER of the checks in
 * {@link verifyOAuthState} is itself the security property: attacker-controlled
 * bytes must never reach a parser before the HMAC authenticates them, so a
 * rejected-MAC verify must record ZERO parses.
 */
function withParseSpy<T>(fn: () => T): { result: T; parseCalls: number } {
  const original = JSON.parse;
  let calls = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    calls++;
    return original(...args);
  }) as typeof JSON.parse;
  try {
    return { result: fn(), parseCalls: calls };
  } finally {
    JSON.parse = original;
  }
}

describe("auth/oauth-state sign + verify", () => {
  it("round-trips the exact claims", () => {
    const claims = stateClaims();
    expect(verifyOAuthState(signOAuthState(claims, SECRET), SECRET, T0)).toEqual({
      v: 1,
      state: "s1",
      nonce: "n1",
      codeVerifier: "cv1",
      returnTo: "/dashboard",
      iat: T0,
    });
  });

  it("emits the two-part base64url wire shape", () => {
    const parts = signOAuthState(stateClaims(), SECRET).split(".");
    expect(parts.length).toBe(2);
    expect(parts[0]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url of a 32-byte HMAC
  });

  it("rejects a value signed under a different secret", () => {
    expect(verifyOAuthState(signOAuthState(stateClaims(), "other"), SECRET, T0)).toBeNull();
  });

  it("rejects structurally malformed values (1 part, 3 parts, empty)", () => {
    expect(verifyOAuthState("nonsense", SECRET, T0)).toBeNull();
    expect(verifyOAuthState("a.b.c", SECRET, T0)).toBeNull();
    expect(verifyOAuthState("", SECRET, T0)).toBeNull();
  });

  it("rejects a flipped payload byte", () => {
    const value = signOAuthState(stateClaims(), SECRET);
    const [payload, sig] = value.split(".");
    const tamperedJson = Buffer.from(payload, "base64url")
      .toString("utf8")
      .replace('"s1"', '"s2"');
    expect(verifyOAuthState(`${base64url(tamperedJson)}.${sig}`, SECRET, T0)).toBeNull();
  });
});

describe("auth/oauth-state verification ORDER (MAC before parse)", () => {
  it("rejects a tampered HMAC WITHOUT ever parsing the payload", () => {
    const value = signOAuthState(stateClaims(), SECRET);
    const [payload, sig] = value.split(".");
    const forgedSig = base64url(Buffer.from(Buffer.from(sig, "base64url").reverse()));
    const { result, parseCalls } = withParseSpy(() =>
      verifyOAuthState(`${payload}.${forgedSig}`, SECRET, T0),
    );
    expect(result).toBeNull();
    expect(parseCalls).toBe(0);
  });

  it("rejects malformed-JSON bytes on the MAC, not on a parse throw", () => {
    // A payload that WOULD throw in JSON.parse, carrying a well-formed but wrong
    // 32-byte signature. If the parse ran first this would still return null —
    // but for the wrong reason — so assert the parse count, not just the result.
    const payloadB64 = base64url("{not json at all");
    const wrongSig = base64url(hmacSha256("wrong-secret", OAUTH_STATE_PURPOSE + payloadB64));
    const { result, parseCalls } = withParseSpy(() =>
      verifyOAuthState(`${payloadB64}.${wrongSig}`, SECRET, T0),
    );
    expect(result).toBeNull();
    expect(parseCalls).toBe(0);
  });

  it("parses exactly once once the MAC authenticates the bytes", () => {
    const { result, parseCalls } = withParseSpy(() =>
      verifyOAuthState(signOAuthState(stateClaims(), SECRET), SECRET, T0),
    );
    expect(result).toEqual(stateClaims());
    expect(parseCalls).toBe(1);
  });

  it("returns null (never throws) for authentic bytes that are not JSON", () => {
    const payloadB64 = base64url("{not json at all");
    const authenticSig = base64url(hmacSha256(SECRET, OAUTH_STATE_PURPOSE + payloadB64));
    expect(verifyOAuthState(`${payloadB64}.${authenticSig}`, SECRET, T0)).toBeNull();
  });
});

describe("auth/oauth-state strict shape whitelist", () => {
  it("rejects an EXTRA unknown field even when authentically signed", () => {
    const value = signRaw({ ...stateClaims(), admin: true });
    expect(verifyOAuthState(value, SECRET, T0)).toBeNull();
  });

  it("rejects a MISSING field", () => {
    const { codeVerifier: _drop, ...missing } = stateClaims();
    expect(verifyOAuthState(signRaw(missing), SECRET, T0)).toBeNull();
  });

  it("rejects wrong field types", () => {
    expect(verifyOAuthState(signRaw(stateClaims({ state: 1 as never })), SECRET, T0)).toBeNull();
    expect(verifyOAuthState(signRaw(stateClaims({ iat: "now" as never })), SECRET, T0)).toBeNull();
    expect(verifyOAuthState(signRaw(stateClaims({ nonce: null as never })), SECRET, T0)).toBeNull();
  });

  it("rejects a non-object payload", () => {
    expect(verifyOAuthState(signRaw(null), SECRET, T0)).toBeNull();
    expect(verifyOAuthState(signRaw([1, 2, 3]), SECRET, T0)).toBeNull();
    expect(verifyOAuthState(signRaw("a string"), SECRET, T0)).toBeNull();
  });

  it("rejects a wrong version — v must be exactly 1", () => {
    expect(verifyOAuthState(signRaw(stateClaims({ v: 2 as never })), SECRET, T0)).toBeNull();
    expect(verifyOAuthState(signRaw(stateClaims({ v: 0 as never })), SECRET, T0)).toBeNull();
    expect(verifyOAuthState(signRaw(stateClaims({ v: "1" as never })), SECRET, T0)).toBeNull();
  });
});

describe("auth/oauth-state domain separation (samo.oauth.state.v1|)", () => {
  it("pins the purpose prefix string", () => {
    expect(OAUTH_STATE_PURPOSE).toBe("samo.oauth.state.v1|");
  });

  it("a state blob NEVER verifies as a session", () => {
    const value = signOAuthState(stateClaims(), SECRET);
    expect(verifySession(value, SECRET, T0)).toBeNull();
  });

  it("a session cookie NEVER verifies as a state blob", () => {
    const value = signSession({ userId: "u-1", tenantId: "t-1", iat: T0 }, SECRET);
    expect(verifyOAuthState(value, SECRET, T0)).toBeNull();
  });

  it("the same payload signed WITHOUT the prefix is rejected", () => {
    const payloadB64 = base64url(JSON.stringify(stateClaims()));
    const unprefixed = `${payloadB64}.${base64url(hmacSha256(SECRET, payloadB64))}`;
    expect(verifyOAuthState(unprefixed, SECRET, T0)).toBeNull();
  });
});

describe("auth/oauth-state TTL (10 minutes, strict > boundary)", () => {
  it("pins the TTL to 600_000 ms", () => {
    expect(OAUTH_STATE_TTL_MS).toBe(600_000);
  });

  it("accepts at EXACTLY now - iat === 600_000 and rejects at 600_001", () => {
    const value = signOAuthState(stateClaims(), SECRET);
    // Boundary: `now - iat > TTL` rejects, so exactly-TTL-old is still ACCEPTED
    // (identical semantics to verifySession's session TTL).
    expect(verifyOAuthState(value, SECRET, T0 + 600_000)).toEqual(stateClaims());
    expect(verifyOAuthState(value, SECRET, T0 + 600_001)).toBeNull();
  });

  it("defaults `now` to the wall clock so a missed call site still ENFORCES the TTL", () => {
    const fresh = stateClaims({ iat: Date.now() });
    expect(verifyOAuthState(signOAuthState(fresh, SECRET), SECRET)).toEqual(fresh);
    const ancient = stateClaims({ iat: 1 }); // 1970
    expect(verifyOAuthState(signOAuthState(ancient, SECRET), SECRET)).toBeNull();
  });

  it("checks the HMAC BEFORE the TTL — an expired blob with a bad MAC is rejected as tampered", () => {
    const value = signOAuthState(stateClaims(), SECRET);
    const [payload, sig] = value.split(".");
    const forgedSig = base64url(Buffer.from(Buffer.from(sig, "base64url").reverse()));
    const { result, parseCalls } = withParseSpy(() =>
      verifyOAuthState(`${payload}.${forgedSig}`, SECRET, T0 + 10 * 600_000),
    );
    expect(result).toBeNull();
    expect(parseCalls).toBe(0);
  });
});

describe("auth/oauth-state callback binding (constant-time state compare)", () => {
  it("accepts the matching state and returns the exact claims", () => {
    const value = signOAuthState(stateClaims(), SECRET);
    expect(verifyOAuthStateForCallback(value, SECRET, "s1", T0)).toEqual(stateClaims());
  });

  it("rejects a MISMATCHED state", () => {
    const value = signOAuthState(stateClaims(), SECRET);
    expect(verifyOAuthStateForCallback(value, SECRET, "s2", T0)).toBeNull();
  });

  it("rejects an absent or empty state — never 'skip when missing'", () => {
    const value = signOAuthState(stateClaims(), SECRET);
    expect(verifyOAuthStateForCallback(value, SECRET, null, T0)).toBeNull();
    expect(verifyOAuthStateForCallback(value, SECRET, "", T0)).toBeNull();
  });

  it("rejects a state that only PREFIXES the real one", () => {
    const value = signOAuthState(stateClaims({ state: "abcdef" }), SECRET);
    expect(verifyOAuthStateForCallback(value, SECRET, "abc", T0)).toBeNull();
    expect(verifyOAuthStateForCallback(value, SECRET, "abcdefg", T0)).toBeNull();
  });

  it("still enforces the MAC and the TTL before the state compare", () => {
    const value = signOAuthState(stateClaims(), SECRET);
    expect(verifyOAuthStateForCallback(value, SECRET, "s1", T0 + 600_001)).toBeNull();
    expect(verifyOAuthStateForCallback(value, "other-secret", "s1", T0)).toBeNull();
  });
});

describe("auth/oauth-state cookie", () => {
  it("uses the __Host- prefixed name", () => {
    expect(OAUTH_STATE_COOKIE_NAME).toBe("__Host-samo_oauth");
    expect(OAUTH_STATE_COOKIE_NAME.startsWith("__Host-")).toBe(true);
  });

  it("builds the exact Set-Cookie string", () => {
    expect(buildOAuthStateCookie("VALUE123")).toBe(
      "__Host-samo_oauth=VALUE123; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600",
    );
  });

  it("builds the exact CLEARING Set-Cookie string", () => {
    expect(buildClearedOAuthStateCookie()).toBe(
      "__Host-samo_oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    );
  });

  it("never emits Domain= (a __Host- cookie carrying Domain is dropped)", () => {
    expect(buildOAuthStateCookie("V")).not.toContain("Domain");
    expect(buildClearedOAuthStateCookie()).not.toContain("Domain");
  });

  it("issueOAuthStateCookie dates the claims by the clock and emits a verifiable cookie", () => {
    const cookie = issueOAuthStateCookie(
      { state: "s9", nonce: "n9", codeVerifier: "cv9", returnTo: "/settings" },
      SECRET,
      () => T0,
    );
    const value = cookie.slice("__Host-samo_oauth=".length, cookie.indexOf(";"));
    expect(cookie).toBe(
      `__Host-samo_oauth=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    );
    expect(verifyOAuthState(value, SECRET, T0)).toEqual({
      v: 1,
      state: "s9",
      nonce: "n9",
      codeVerifier: "cv9",
      returnTo: "/settings",
      iat: T0,
    });
  });

  it("readOAuthStateCookie lifts the value off the Cookie header", () => {
    const req = new Request("https://x.test/auth/google/callback", {
      headers: { cookie: "samo_session=abc; __Host-samo_oauth=VALUE123; other=1" },
    });
    expect(readOAuthStateCookie(req)).toBe("VALUE123");
  });

  it("readOAuthStateCookie returns null when absent, and never matches a suffix name", () => {
    expect(readOAuthStateCookie(new Request("https://x.test/"))).toBeNull();
    const noneReq = new Request("https://x.test/", {
      headers: { cookie: "samo_session=abc" },
    });
    expect(readOAuthStateCookie(noneReq)).toBeNull();
    // "samo_oauth" (no __Host- prefix) is a DIFFERENT cookie a sibling origin
    // could set; it must never be read as the state cookie.
    const spoofReq = new Request("https://x.test/", {
      headers: { cookie: "samo_oauth=EVIL" },
    });
    expect(readOAuthStateCookie(spoofReq)).toBeNull();
  });
});

describe("auth/oauth-state PKCE S256", () => {
  it("matches the RFC 7636 Appendix B known-answer vector", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("is deterministic, URL-safe, unpadded, and 43 chars", () => {
    const a = codeChallengeS256("verifier-one");
    expect(a).toBe(codeChallengeS256("verifier-one"));
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(codeChallengeS256("verifier-two"));
  });
});

describe("auth/oauth-state validateReturnTo (enumerated allowlist)", () => {
  const VALID_UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

  it("returns the allowlisted path unchanged", () => {
    expect(validateReturnTo("/dashboard")).toBe("/dashboard");
    expect(validateReturnTo("/settings")).toBe("/settings");
    expect(validateReturnTo(`/calls/${VALID_UUID}`)).toBe(`/calls/${VALID_UUID}`);
  });

  it("falls back to /dashboard rather than erroring", () => {
    expect(DEFAULT_RETURN_TO).toBe("/dashboard");
    expect(validateReturnTo(null)).toBe("/dashboard");
    expect(validateReturnTo(undefined)).toBe("/dashboard");
    expect(validateReturnTo("")).toBe("/dashboard");
  });

  // Each open-redirect vector is asserted individually — a bulk loop hides which
  // one regressed. These are exactly the shapes a "starts with /" check accepts.
  it("rejects a protocol-relative URL (//evil.com)", () => {
    expect(validateReturnTo("//evil.com")).toBe("/dashboard");
    expect(validateReturnTo("//evil.com/dashboard")).toBe("/dashboard");
  });

  it("rejects a backslash-authority URL (/\\evil.com)", () => {
    expect(validateReturnTo("/\\evil.com")).toBe("/dashboard");
    expect(validateReturnTo("/\\/evil.com")).toBe("/dashboard");
  });

  it("rejects an absolute https URL", () => {
    expect(validateReturnTo("https://evil.com")).toBe("/dashboard");
    expect(validateReturnTo("https://evil.com/dashboard")).toBe("/dashboard");
  });

  it("rejects a scheme-relative / userinfo confusion path (/dashboard@evil.com)", () => {
    expect(validateReturnTo("/dashboard@evil.com")).toBe("/dashboard");
    expect(validateReturnTo("//evil.com@samograph.samo.team/dashboard")).toBe("/dashboard");
  });

  it("rejects a percent-encoded protocol-relative URL", () => {
    expect(validateReturnTo("/%2f%2fevil.com")).toBe("/dashboard");
    expect(validateReturnTo("/%5cevil.com")).toBe("/dashboard");
  });

  it("rejects a path carrying CRLF (header/log injection)", () => {
    expect(validateReturnTo("/dashboard\r\nSet-Cookie: a=b")).toBe("/dashboard");
    expect(validateReturnTo("/dashboard\n")).toBe("/dashboard");
    expect(validateReturnTo("/dashboard\r")).toBe("/dashboard");
  });

  it("rejects near-miss allowlist entries (prefix, suffix, query, fragment, case)", () => {
    expect(validateReturnTo("/dashboardx")).toBe("/dashboard");
    expect(validateReturnTo("/dashboard/")).toBe("/dashboard");
    expect(validateReturnTo("/dashboard?next=//evil.com")).toBe("/dashboard");
    expect(validateReturnTo("/dashboard#//evil.com")).toBe("/dashboard");
    expect(validateReturnTo("/Dashboard")).toBe("/dashboard");
    expect(validateReturnTo(" /dashboard")).toBe("/dashboard");
    expect(validateReturnTo("dashboard")).toBe("/dashboard");
  });

  it("rejects a /calls path whose id is not a UUID, or that has extra segments", () => {
    expect(validateReturnTo("/calls/not-a-uuid")).toBe("/dashboard");
    expect(validateReturnTo("/calls")).toBe("/dashboard");
    expect(validateReturnTo("/calls/")).toBe("/dashboard");
    expect(validateReturnTo(`/calls/${VALID_UUID}/edit`)).toBe("/dashboard");
    expect(validateReturnTo(`/calls/${VALID_UUID}?a=1`)).toBe("/dashboard");
    expect(validateReturnTo(`//calls/${VALID_UUID}`)).toBe("/dashboard");
  });

  it("rejects paths outside the allowlist even when they are real internal routes", () => {
    // The allowlist is ENUMERATED: a route existing is not enough to be a
    // post-sign-in landing target (share-token pages carry a capability).
    expect(validateReturnTo("/c/some-share-token")).toBe("/dashboard");
    expect(validateReturnTo("/auth")).toBe("/dashboard");
    expect(validateReturnTo("/")).toBe("/dashboard");
  });
});
