/**
 * Capability-token SIGNING tests — the pure crypto half of §6.2 #2.
 *
 * These exercise the no-I/O signer/verifier (HMAC-SHA256, KID in payload,
 * constant-time compare, KID rotation overlap) and the persisted-vs-derived
 * scope model (§5.7, §4.2). No DATABASE_URL needed — they always run.
 *
 * Strict red/green TDD: written BEFORE ./signing.ts exists. Exact-value
 * assertions (not mere existence) per the engineering process.
 */
import { describe, it, expect } from "bun:test";
import {
  signToken,
  verifyTokenSignature,
  constantTimeEqual,
  tokenGrants,
  assertPersistableScopes,
  isPersistedScope,
  PERSISTED_SCOPES,
  type Keyring,
  type SigningKey,
  type TokenPayload,
} from "./signing.ts";

// Three keys modelling a 90-day / 30-day rotation overlap (§5.1, §5.7):
// k2 is current, k1 is the previous (still accepted during overlap), k0 is
// fully retired (must be rejected).
const KEY_CURRENT: SigningKey = { kid: "k2", secret: "current-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
const KEY_PREVIOUS: SigningKey = { kid: "k1", secret: "previous-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
const KEY_RETIRED: SigningKey = { kid: "k0", secret: "retired-secret-cccccccccccccccccccccccccccc" };
const keyring: Keyring = { current: KEY_CURRENT, previous: KEY_PREVIOUS };

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const NOW = 1_700_000_000; // fixed epoch seconds

function makePayload(over: Partial<TokenPayload> = {}): TokenPayload {
  return {
    kid: KEY_CURRENT.kid,
    call_id: CALL_ID,
    scopes: ["share"],
    iat: NOW,
    exp: NOW + 3600,
    jti: "jti-fixed-0001",
    ...over,
  };
}

describe("signToken / verifyTokenSignature (pure crypto, §5.7)", () => {
  it("round-trips a share token under the current KID (exact payload preserved)", () => {
    const token = signToken(makePayload(), KEY_CURRENT);
    expect(token.split(".").length).toBe(2); // base64url(body).base64url(sig)

    const res = verifyTokenSignature(token, keyring, { now: NOW + 10 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.payload).toEqual(makePayload());
  });

  it("binds KID to its secret — signToken refuses payload.kid != key.kid", () => {
    expect(() => signToken(makePayload({ kid: "k9" }), KEY_CURRENT)).toThrow(/kid/i);
  });

  it("accepts a token signed under the PREVIOUS KID (rotation overlap)", () => {
    const token = signToken(makePayload({ kid: KEY_PREVIOUS.kid }), KEY_PREVIOUS);
    const res = verifyTokenSignature(token, keyring, { now: NOW + 10 });
    expect(res.ok).toBe(true);
  });

  it("rejects a token whose KID is neither current nor previous (retired/wrong KID)", () => {
    const token = signToken(makePayload({ kid: KEY_RETIRED.kid }), KEY_RETIRED);
    const res = verifyTokenSignature(token, keyring, { now: NOW + 10 });
    expect(res).toEqual({ ok: false, reason: "unknown_kid" });
  });

  it("rejects the right KID label signed with the wrong secret (forged signature)", () => {
    const forged: SigningKey = { kid: KEY_CURRENT.kid, secret: "totally-wrong-secret" };
    const token = signToken(makePayload(), forged);
    const res = verifyTokenSignature(token, keyring, { now: NOW + 10 });
    expect(res).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects an expired token (exp < now)", () => {
    const token = signToken(makePayload({ iat: NOW - 7200, exp: NOW - 3600 }), KEY_CURRENT);
    const res = verifyTokenSignature(token, keyring, { now: NOW });
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts just before exp and rejects exactly at exp", () => {
    const token = signToken(makePayload({ iat: NOW, exp: NOW + 100 }), KEY_CURRENT);
    expect(verifyTokenSignature(token, keyring, { now: NOW + 99 }).ok).toBe(true);
    expect(verifyTokenSignature(token, keyring, { now: NOW + 100 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a tampered payload — flipping scopes to act:chat breaks the HMAC", () => {
    const token = signToken(makePayload(), KEY_CURRENT);
    const [body, sig] = token.split(".");
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    decoded.scopes = ["act:chat"]; // privilege-escalation attempt
    const tamperedBody = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
    const res = verifyTokenSignature(`${tamperedBody}.${sig}`, keyring, { now: NOW + 10 });
    expect(res).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects malformed tokens (wrong part count / undecodable / non-JSON)", () => {
    expect(verifyTokenSignature("", keyring, { now: NOW })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTokenSignature("only-one-part", keyring, { now: NOW })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyTokenSignature("a.b.c", keyring, { now: NOW })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTokenSignature("!!!.???", keyring, { now: NOW })).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("scope model — persisted vs derived (§5.7, §4.2)", () => {
  it("lists exactly the PERSISTED scopes (share + act:*) and NEVER read", () => {
    expect([...PERSISTED_SCOPES]).toEqual([
      "share",
      "act:chat",
      "act:frame",
      "act:presence",
      "act:leave",
    ]);
    expect(PERSISTED_SCOPES).not.toContain("read");
  });

  it("isPersistedScope: share + act:* true; read + unknown false", () => {
    expect(isPersistedScope("share")).toBe(true);
    expect(isPersistedScope("act:chat")).toBe(true);
    expect(isPersistedScope("act:frame")).toBe(true);
    expect(isPersistedScope("act:presence")).toBe(true);
    expect(isPersistedScope("act:leave")).toBe(true);
    expect(isPersistedScope("read")).toBe(false);
    expect(isPersistedScope("act:bogus")).toBe(false);
  });

  it("assertPersistableScopes throws on read (read is NEVER a persisted token)", () => {
    expect(() => assertPersistableScopes(["read"])).toThrow(/read.*not a persisted/i);
    expect(() => assertPersistableScopes(["share", "read"])).toThrow(/read/);
    expect(() => assertPersistableScopes(["act:bogus"])).toThrow();
    expect(() => assertPersistableScopes([])).toThrow(/at least one/i);
    expect(() => assertPersistableScopes(["share"])).not.toThrow();
    expect(() => assertPersistableScopes(["act:chat"])).not.toThrow();
  });

  it("tokenGrants: scope mismatch denied (token holds only share, asks act:chat)", () => {
    expect(tokenGrants(["share"], "act:chat")).toBe(false);
    expect(tokenGrants(["share"], "share")).toBe(true);
    expect(tokenGrants(["act:chat"], "act:chat")).toBe(true);
    expect(tokenGrants(["act:chat", "share"], "act:frame")).toBe(false);
  });

  // The same verifier handles every persisted scope — share is minted in v1;
  // act:* round-trips through the verifier already, even though unminted (§5.7).
  for (const scope of PERSISTED_SCOPES) {
    it(`verifier round-trips and grants the "${scope}" scope`, () => {
      const token = signToken(makePayload({ scopes: [scope] }), KEY_CURRENT);
      const res = verifyTokenSignature(token, keyring, { now: NOW + 10 });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(res.reason);
      expect(res.payload.scopes).toEqual([scope]);
      expect(tokenGrants(res.payload.scopes, scope)).toBe(true);
    });
  }
});

describe("constant-time signature comparison (timing-attack resistance, §5.7)", () => {
  it("constantTimeEqual: equal→true, same-length-differ→false, different-length→false (no throw)", () => {
    expect(constantTimeEqual("abcdef", "abcdef")).toBe(true);
    expect(constantTimeEqual("abcdef", "abcdeX")).toBe(false);
    // A bare crypto.timingSafeEqual throws on unequal length; a guarded
    // constant-time compare must return false instead of throwing.
    expect(constantTimeEqual("abcdef", "abcde")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("structure: signature compare goes through node:crypto timingSafeEqual, never `===`", async () => {
    const src = await Bun.file(new URL("./signing.ts", import.meta.url)).text();
    expect(src).toContain("timingSafeEqual");
    expect(src).toMatch(/constantTimeEqual\s*\(/);
  });

  it("difference position is irrelevant — first-byte and last-byte flips both invalid", () => {
    const token = signToken(makePayload(), KEY_CURRENT);
    const [body, sig] = token.split(".");
    const flip = (c: string) => (c === "A" ? "B" : "A");
    const flipFirst = flip(sig[0]) + sig.slice(1);
    const flipLast = sig.slice(0, -1) + flip(sig[sig.length - 1]);
    expect(verifyTokenSignature(`${body}.${flipFirst}`, keyring, { now: NOW + 10 })).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
    expect(verifyTokenSignature(`${body}.${flipLast}`, keyring, { now: NOW + 10 })).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });
});
