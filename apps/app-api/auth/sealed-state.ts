import type { Clock } from "./types.ts";
import { base64url, constantTimeEqual, fromBase64url, hmacSha256 } from "./crypto.ts";

export interface SealedStateOptions<T extends { v: number; state: string; iat: number }> {
  cookieName: string;
  purpose: string;
  ttlMs: number;
  fields: readonly string[];
  parseClaims(value: Record<string, unknown>): T | null;
}

export function createSealedState<T extends { v: number; state: string; iat: number }>(
  options: SealedStateOptions<T>,
) {
  const sign = (claims: T, secret: string): string => {
    const payload = base64url(JSON.stringify(claims));
    return `${payload}.${base64url(hmacSha256(secret, options.purpose + payload))}`;
  };
  const verify = (value: string, secret: string, now = Date.now()): T | null => {
    const parts = value.split(".");
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    if (!constantTimeEqual(hmacSha256(secret, options.purpose + payload), fromBase64url(signature))) return null;
    let unknown: unknown;
    try { unknown = JSON.parse(fromBase64url(payload).toString("utf8")); } catch { return null; }
    if (typeof unknown !== "object" || unknown === null || Array.isArray(unknown)) return null;
    const record = unknown as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== options.fields.length || options.fields.some((key) => !Object.hasOwn(record, key))) return null;
    const claims = options.parseClaims(record);
    if (claims === null || claims.v !== 1 || now - claims.iat > options.ttlMs) return null;
    return claims;
  };
  const verifyCallback = (value: string, secret: string, state: string | null | undefined, now = Date.now()): T | null => {
    const claims = verify(value, secret, now);
    if (claims === null || typeof state !== "string" || state.length === 0) return null;
    return constantTimeEqual(Buffer.from(claims.state), Buffer.from(state)) ? claims : null;
  };
  const cookie = (value: string, maxAge = Math.floor(options.ttlMs / 1000)): string =>
    `${options.cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  const readCookie = (req: Request): string | null => {
    for (const part of (req.headers.get("cookie") ?? "").split(";")) {
      const index = part.indexOf("=");
      if (index >= 0 && part.slice(0, index).trim() === options.cookieName) return part.slice(index + 1).trim();
    }
    return null;
  };
  return {
    sign, verify, verifyCallback, readCookie,
    buildCookie: (value: string) => cookie(value),
    buildClearedCookie: () => cookie("", 0),
    issueCookie: (claims: Omit<T, "v" | "iat">, secret: string, clock: Clock) =>
      cookie(sign({ v: 1, ...claims, iat: clock() } as T, secret)),
  };
}
