/**
 * Dev app-api wrapper (`dev-server.ts`) — refuses to boot outside SAMO_ENV=dev.
 *
 * dev-server.ts carries the LOCAL-ONLY shortcuts (dev-default secret fallbacks,
 * the `Secure`-strip, `GET /__dev/last-magic-link`). If a prod box mistakenly
 * launches it, it MUST hard-throw before doing anything — the gate is
 * `SAMO_ENV === 'dev'` (default prod = fail-safe). The module is guarded by
 * `import.meta.main`, so importing it here does NOT auto-start a server.
 */
import { describe, it, expect } from "bun:test";
import { assertDevEnv, startDevServer, devCookieFix } from "./dev-server.ts";

describe("dev-server.ts — DEV-ONLY boot gate", () => {
  it("assertDevEnv throws when SAMO_ENV is absent (defaults to prod)", () => {
    expect(() => assertDevEnv({})).toThrow(/SAMO_ENV/);
  });
  it("assertDevEnv throws when SAMO_ENV=prod", () => {
    expect(() => assertDevEnv({ SAMO_ENV: "prod" })).toThrow(/dev/i);
  });
  it("assertDevEnv does NOT throw when SAMO_ENV=dev", () => {
    expect(() => assertDevEnv({ SAMO_ENV: "dev" })).not.toThrow();
  });
  it("startDevServer throws (before any bind/connect) when SAMO_ENV!=dev", () => {
    expect(() =>
      startDevServer({ SAMO_ENV: "prod", DATABASE_URL: "postgres://x/y" }),
    ).toThrow();
  });
});

/** The exact session cookie `buildSessionCookie` emits, minus the opaque value. */
const SESSION_COOKIE = "samo_session=abc.def; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1209600";
/** The §5.1-style cleared OAuth state cookie the Google callback emits alongside it (issue #209). */
const HOST_COOKIE = "__Host-samo_oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

function withCookies(...cookies: readonly string[]): Response {
  const headers = new Headers();
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

describe("devCookieFix — DEV-ONLY Set-Cookie Secure-strip", () => {
  it("keeps BOTH Set-Cookie headers when a response carries two (the Google callback shape)", () => {
    const out = devCookieFix(withCookies(SESSION_COOKIE, HOST_COOKIE));
    expect(out.headers.getSetCookie()).toEqual([
      "samo_session=abc.def; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600",
      "__Host-samo_oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    ]);
  });

  it("leaves a `__Host-` cookie COMPLETELY untouched (the prefix REQUIRES Secure)", () => {
    const out = devCookieFix(withCookies(HOST_COOKIE));
    expect(out.headers.getSetCookie()).toEqual([HOST_COOKIE]);
  });

  it("matches the `__Host-` prefix case-insensitively (RFC 6265bis §4.1.3.2)", () => {
    const upper = "__HOST-samo_oauth=v; Path=/; HttpOnly; Secure; SameSite=Lax";
    expect(devCookieFix(withCookies(upper)).headers.getSetCookie()).toEqual([upper]);
  });

  it("still strips Secure from an ordinary session cookie (the shim's original job)", () => {
    const out = devCookieFix(withCookies(SESSION_COOKIE));
    expect(out.headers.getSetCookie()).toEqual([
      "samo_session=abc.def; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600",
    ]);
  });

  it("returns a response with NO Set-Cookie unchanged (same object, status preserved)", () => {
    const res = new Response("ok", { status: 200 });
    const out = devCookieFix(res);
    expect(out).toBe(res);
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie()).toEqual([]);
  });

  it("preserves status, statusText and non-cookie headers", async () => {
    const headers = new Headers({ location: "/dashboard", "x-trace": "t1" });
    headers.append("set-cookie", SESSION_COOKIE);
    const out = devCookieFix(new Response("body", { status: 302, statusText: "Found", headers }));
    expect(out.status).toBe(302);
    expect(out.statusText).toBe("Found");
    expect(out.headers.get("location")).toBe("/dashboard");
    expect(out.headers.get("x-trace")).toBe("t1");
    expect(await out.text()).toBe("body");
  });
});
