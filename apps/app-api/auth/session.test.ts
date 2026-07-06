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
    expect(verifySession(value, SECRET)).toEqual(claims);
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
    expect(verifySession(value, SECRET)).toEqual({ userId: "u-9", tenantId: "t-9", iat: 12_345 });
  });
});
