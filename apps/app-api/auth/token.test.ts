import { describe, it, expect } from "bun:test";
import { base64url } from "./crypto.ts";
import { SigningKeyring } from "./keyring.ts";
import {
  MAGIC_LINK_TTL_MS,
  issueMagicLinkToken,
  verifyMagicLinkToken,
} from "./token.ts";

// Current KID "k2"; "k1" is the previous KID still inside the 30-day overlap.
const keyring = () =>
  new SigningKeyring("k2", { k1: "old-secret-k1", k2: "new-secret-k2" });

const T0 = 1_700_000_000_000; // fixed epoch ms

describe("auth/token", () => {
  it("TTL constant is 15 minutes", () => {
    expect(MAGIC_LINK_TTL_MS).toBe(900_000);
  });

  it("mints with current KID and round-trips inside the TTL", () => {
    const kr = keyring();
    const { token, claims } = issueMagicLinkToken({
      email: "user@example.com",
      keyring: kr,
      now: T0,
      jti: "jti-1",
    });
    expect(claims.kid).toBe("k2");
    expect(claims.jti).toBe("jti-1");
    expect(claims.email).toBe("user@example.com");
    expect(claims.iat).toBe(T0);
    expect(claims.exp).toBe(T0 + 900_000);

    const res = verifyMagicLinkToken(token, { keyring: kr, now: T0 + 60_000 });
    expect(res).toEqual({ ok: true, claims });
  });

  it("accepts a token signed with the PREVIOUS KID (30-day overlap)", () => {
    const kr = keyring();
    // Force issuance under the previous KID by signing with a keyring whose
    // current KID is k1, then verify with the rotated keyring (current k2).
    const old = new SigningKeyring("k1", { k1: "old-secret-k1" });
    const { token } = issueMagicLinkToken({
      email: "user@example.com",
      keyring: old,
      now: T0,
      jti: "jti-prev",
    });
    const res = verifyMagicLinkToken(token, { keyring: kr, now: T0 + 60_000 });
    expect(res.ok).toBe(true);
  });

  it("rejects an unknown / tampered KID → SAMO-AUTH-001", () => {
    const kr = keyring();
    const { token } = issueMagicLinkToken({
      email: "user@example.com",
      keyring: kr,
      now: T0,
      jti: "jti-2",
    });
    // Re-point the payload at a KID the keyring does not hold.
    const [payloadB64, sig] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    payload.kid = "k9";
    const tampered = `${base64url(JSON.stringify(payload))}.${sig}`;
    const res = verifyMagicLinkToken(tampered, { keyring: kr, now: T0 + 1000 });
    expect(res).toEqual({ ok: false, code: "SAMO-AUTH-001" });
  });

  it("rejects a signature mismatch (flipped payload, stale sig) → SAMO-AUTH-001", () => {
    const kr = keyring();
    const { token } = issueMagicLinkToken({
      email: "user@example.com",
      keyring: kr,
      now: T0,
      jti: "jti-3",
    });
    const [payloadB64, sig] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    payload.email = "attacker@evil.com"; // tamper, keep the old signature
    const forged = `${base64url(JSON.stringify(payload))}.${sig}`;
    const res = verifyMagicLinkToken(forged, { keyring: kr, now: T0 + 1000 });
    expect(res).toEqual({ ok: false, code: "SAMO-AUTH-001" });
  });

  it("rejects a structurally malformed token → SAMO-AUTH-001", () => {
    const kr = keyring();
    expect(verifyMagicLinkToken("garbage", { keyring: kr, now: T0 })).toEqual({
      ok: false,
      code: "SAMO-AUTH-001",
    });
    expect(verifyMagicLinkToken("a.b.c", { keyring: kr, now: T0 })).toEqual({
      ok: false,
      code: "SAMO-AUTH-001",
    });
  });

  it("rejects an expired token → SAMO-AUTH-002 ('clicked 14:59, consumed 15:01')", () => {
    const kr = keyring();
    // Issue at 14:46:00 → exp = 15:01:00 exactly.
    const issuedAt = Date.parse("2026-06-28T14:46:00.000Z");
    const { token } = issueMagicLinkToken({
      email: "user@example.com",
      keyring: kr,
      now: issuedAt,
      jti: "jti-ttl",
    });
    // Clicked at 14:59 → still valid.
    const clicked = verifyMagicLinkToken(token, {
      keyring: kr,
      now: Date.parse("2026-06-28T14:59:00.000Z"),
    });
    expect(clicked.ok).toBe(true);
    // Consumed at 15:01 → past exp (15:01:00) → expired.
    const consumed = verifyMagicLinkToken(token, {
      keyring: kr,
      now: Date.parse("2026-06-28T15:01:00.000Z"),
    });
    expect(consumed).toEqual({ ok: false, code: "SAMO-AUTH-002" });
  });

  it("treats exp as exclusive: now === exp is already expired", () => {
    const kr = keyring();
    const { token } = issueMagicLinkToken({
      email: "user@example.com",
      keyring: kr,
      now: T0,
      jti: "jti-edge",
    });
    expect(verifyMagicLinkToken(token, { keyring: kr, now: T0 + 900_000 })).toEqual({
      ok: false,
      code: "SAMO-AUTH-002",
    });
    expect(
      verifyMagicLinkToken(token, { keyring: kr, now: T0 + 899_999 }).ok,
    ).toBe(true);
  });
});
