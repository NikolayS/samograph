import { describe, it, expect } from "bun:test";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  signSession,
  verifySession,
  buildSessionCookie,
  buildClearedSessionCookie,
  issueSessionCookie,
} from "./session.ts";

const SECRET = "session-secret-xyz";

describe("auth/session", () => {
  it("signs and verifies session claims round-trip", () => {
    const claims = { userId: "u-1", tenantId: "t-1", iat: 1_700_000_000_000 };
    const value = signSession(claims, SECRET);
    // Pin `now` to the issue time so this round-trip decode is not gated by the
    // server-side TTL (that boundary is covered by the dedicated TTL suite below).
    expect(verifySession(value, SECRET, claims.iat)).toEqual(claims);
  });

  it("rejects a tampered payload (returns null)", () => {
    const value = signSession({ userId: "u-1", tenantId: "t-1", iat: 1 }, SECRET);
    const [payload, sig] = value.split(".");
    const flipped = Buffer.from(payload, "base64url").toString("utf8").replace("u-1", "u-2");
    const forged = `${Buffer.from(flipped).toString("base64url")}.${sig}`;
    expect(verifySession(forged, SECRET)).toBeNull();
  });

  it("rejects a session signed with a different secret", () => {
    const value = signSession({ userId: "u-1", tenantId: "t-1", iat: 1 }, SECRET);
    expect(verifySession(value, "other-secret")).toBeNull();
  });

  it("rejects structurally malformed cookie values", () => {
    expect(verifySession("nonsense", SECRET)).toBeNull();
    expect(verifySession("a.b.c", SECRET)).toBeNull();
  });

  it("builds a Set-Cookie with HttpOnly, Secure, SameSite=Lax, Path, Max-Age", () => {
    const cookie = buildSessionCookie("VALUE123");
    expect(cookie).toBe(
      `${SESSION_COOKIE_NAME}=VALUE123; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(
        SESSION_TTL_MS / 1000,
      )}`,
    );
  });

  it("buildClearedSessionCookie clears the cookie (empty value, Max-Age=0, same security attrs)", () => {
    const cookie = buildClearedSessionCookie();
    expect(cookie).toBe(
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    );
    // The value is empty (unsets the cookie) and it can never verify as a session.
    expect(verifySession("", SECRET)).toBeNull();
  });

  it("issueSessionCookie dates claims by the clock and emits a verifiable cookie", () => {
    const cookie = issueSessionCookie({ userId: "u-9", tenantId: "t-9" }, SECRET, () => 12_345);
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    const value = cookie.slice(`${SESSION_COOKIE_NAME}=`.length, cookie.indexOf(";"));
    // iat 12_345 (1970) is far past the TTL against the wall clock, so pin `now`
    // to the issue time to assert the round-trip decode.
    expect(verifySession(value, SECRET, 12_345)).toEqual({ userId: "u-9", tenantId: "t-9", iat: 12_345 });
  });
});

describe("auth/session server-side TTL (§5.1 — iat vs clock)", () => {
  const NOW = 1_900_000_000_000; // fixed reference clock (2030-03-17)
  const DAY = 24 * 60 * 60 * 1000;
  const MIN = 60 * 1000;
  const claimsAgedBy = (ageMs: number) => ({ userId: "u-ttl", tenantId: "t-ttl", iat: NOW - ageMs });

  it("accepts a validly-signed session inside the TTL window (29d 59m old)", () => {
    const claims = claimsAgedBy(29 * DAY + 59 * MIN);
    const value = signSession(claims, SECRET);
    expect(verifySession(value, SECRET, NOW)).toEqual(claims);
  });

  it("rejects a validly-signed session past the TTL (30d 1m old) — the HMAC alone is not enough", () => {
    const claims = claimsAgedBy(30 * DAY + 1 * MIN);
    const value = signSession(claims, SECRET);
    expect(verifySession(value, SECRET, NOW)).toBeNull();
  });

  it("uses a strict > TTL boundary: exactly TTL-old is accepted, one ms older is rejected", () => {
    const atEdge = claimsAgedBy(SESSION_TTL_MS); // now - iat == TTL → NOT > TTL → accepted
    const overEdge = claimsAgedBy(SESSION_TTL_MS + 1); // now - iat == TTL+1 → > TTL → rejected
    expect(verifySession(signSession(atEdge, SECRET), SECRET, NOW)).toEqual(atEdge);
    expect(verifySession(signSession(overEdge, SECRET), SECRET, NOW)).toBeNull();
  });

  it("defaults `now` to the wall clock so a missed call site still ENFORCES the TTL", () => {
    const fresh = { userId: "u", tenantId: "t", iat: Date.now() };
    expect(verifySession(signSession(fresh, SECRET), SECRET)).toEqual(fresh);
    const ancient = { userId: "u", tenantId: "t", iat: 1 }; // 1970 — decades old
    expect(verifySession(signSession(ancient, SECRET), SECRET)).toBeNull();
  });

  it("checks the constant-time HMAC BEFORE the TTL — a tampered, too-old cookie is rejected as tampered (no iat oracle)", () => {
    const expired = claimsAgedBy(40 * DAY); // well past TTL, but validly signed…
    const value = signSession(expired, SECRET);
    const [payload, sig] = value.split(".");
    // …then corrupt the signature. HMAC compare must fail first → null regardless of iat.
    const forgedSig = Buffer.from(Buffer.from(sig, "base64url").reverse()).toString("base64url");
    expect(verifySession(`${payload}.${forgedSig}`, SECRET, NOW)).toBeNull();
  });
});
