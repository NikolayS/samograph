/**
 * `createAppApi` composition factory (issues #105 + #64).
 *
 * The pure factory builds the SAME auth + calls wiring the dev-server used to
 * inline, MINUS the unconditional Set-Cookie `Secure`-strip. The dev-only bits
 * (the `Secure`-strip and `GET /__dev/last-magic-link`) exist ONLY when a
 * `devShortcuts` object is supplied — otherwise they are absent from the built
 * handler, not merely disabled. These are DB-free unit tests: the `POST
 * /auth/logout` route deterministically emits the fixed `Secure` session cookie
 * with no token and no DB, so it isolates the Secure-cookie behaviour exactly.
 */
import { describe, it, expect } from "bun:test";
import type { SQL } from "bun";
import { createAppApi, type AppApiConfig, type DevShortcuts } from "./app.ts";
import {
  InMemoryEmailSender,
  InMemoryOAuthProvider,
  IN_MEMORY_AUTHORIZE_URL,
} from "./auth/index.ts";
import { devCookieFix } from "./dev-server.ts";

const SESSION_SECRET = "app-test-session-secret-aaaaaaaaaaaaaaaaaaaa";

function baseConfig(): AppApiConfig {
  return {
    // The logout route never touches the DB, so a bare object satisfies the
    // PostgresUserStore/calls wiring without a live connection.
    sql: {} as unknown as SQL,
    sessionSecret: SESSION_SECRET,
    magicLinkKid: "test-kid",
    magicLinkSecret: "test-magic-secret",
    tokenKeyring: { current: { kid: "test-share", secret: "test-token-secret" } },
    emailSender: new InMemoryEmailSender(),
    webOrigin: "http://web.test",
    enqueue: () => {},
  };
}

/**
 * The exact dev shortcuts the dev wrapper injects. `stripSecureCookie` is the
 * REAL `devCookieFix` from `dev-server.ts`, not a re-implementation — an inline
 * copy silently drifts from the shim that actually runs locally.
 */
const devShortcuts: DevShortcuts = {
  lastMagicLink: () => Response.json({ ok: true, link: "http://web.test/auth/callback?token=x" }, { status: 200 }),
  stripSecureCookie: devCookieFix,
};

describe("createAppApi — PROD composition (no devShortcuts)", () => {
  it("RETAINS Secure on the session Set-Cookie (POST /auth/logout)", async () => {
    const api = createAppApi(baseConfig());
    const res = await api.fetch(new Request("http://api.test/auth/logout", { method: "POST" }));
    expect(res.status).toBe(204);
    const sc = res.headers.get("set-cookie");
    expect(sc).not.toBeNull();
    expect(sc).toContain("samo_session=");
    expect(sc).toContain("Secure");
  });

  it("GET /__dev/last-magic-link is ABSENT → 404", async () => {
    const api = createAppApi(baseConfig());
    const res = await api.fetch(new Request("http://api.test/__dev/last-magic-link"));
    expect(res.status).toBe(404);
  });

  it("GET /health still returns 200 ok", async () => {
    const api = createAppApi(baseConfig());
    const res = await api.fetch(new Request("http://api.test/health"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("with devShortcuts EXPLICITLY undefined, the Secure cookie survives byte-for-byte", async () => {
    const api = createAppApi({ ...baseConfig(), devShortcuts: undefined });
    const res = await api.fetch(new Request("http://api.test/auth/logout", { method: "POST" }));
    expect(res.status).toBe(204);
    // Byte-for-byte the value `buildClearedSessionCookie()` emits: the shim is
    // ABSENT from the prod handler, so nothing rewrote this header.
    expect(res.headers.getSetCookie()).toEqual([
      "samo_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    ]);
  });
});

describe("createAppApi — DEV composition (devShortcuts present)", () => {
  it("STRIPS Secure from the session Set-Cookie (POST /auth/logout)", async () => {
    const api = createAppApi({ ...baseConfig(), devShortcuts });
    const res = await api.fetch(new Request("http://api.test/auth/logout", { method: "POST" }));
    expect(res.status).toBe(204);
    const sc = res.headers.get("set-cookie");
    expect(sc).not.toBeNull();
    expect(sc).toContain("samo_session=");
    expect(sc).not.toContain("Secure");
  });

  it("GET /__dev/last-magic-link is SERVED → 200", async () => {
    const api = createAppApi({ ...baseConfig(), devShortcuts });
    const res = await api.fetch(new Request("http://api.test/__dev/last-magic-link"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

/**
 * Google sign-in wiring (issue #209, PR 5 of 7).
 *
 * `createAppApi` stays PURE: it reads no environment. The caller resolves the
 * provider (`googleOAuthFromEnv` in the entrypoints) and hands it in, so the
 * presence of `googleOAuth` in the config IS the on/off switch — which is why
 * branch previews, which are given no Google credentials, compose the exact same
 * handler and simply report `{"google":false}`.
 *
 * DB-free: `/auth/providers` and the unconfigured `/auth/google/*` stubs never
 * reach a store, so the bare `sql` object above is enough.
 */
describe("createAppApi — Google sign-in routes (#209)", () => {
  it("GET /auth/providers reports {\"google\":false} with no provider configured", async () => {
    const api = createAppApi(baseConfig());
    const res = await api.fetch(new Request("http://api.test/auth/providers"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ google: false, google_calendar: false });
  });

  it("GET /auth/providers reports {\"google\":true} once a provider is composed", async () => {
    const api = createAppApi({
      ...baseConfig(),
      googleOAuth: new InMemoryOAuthProvider(),
    });
    const res = await api.fetch(new Request("http://api.test/auth/providers"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ google: true, google_calendar: false });
  });

  it("reports Google Calendar independently and fail-closed", async () => {
    const api = createAppApi({
      ...baseConfig(),
      googleCalendarOAuth: {
        authorizeUrl: () => "https://google.test",
        async exchangeCode() { return { ok: false }; },
        async revoke() { return true; },
      },
      calendarTokenEncryption: {
        activeKey: Buffer.alloc(32, 1), activeKeyVersion: 1,
        decryptionKeys: new Map([[1, Buffer.alloc(32, 1)]]),
      },
    });
    const res = await api.fetch(new Request("http://api.test/auth/providers"));
    expect(await res.json()).toEqual({ google: false, google_calendar: true });
  });

  it("GET /auth/google/start 302s to SAMO-AUTH-010 on an env with no provider", async () => {
    const api = createAppApi(baseConfig());
    const res = await api.fetch(new Request("http://api.test/auth/google/start"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth?error=SAMO-AUTH-010");
  });

  it("GET /auth/google/start 302s to the provider and sets the __Host- state cookie", async () => {
    const api = createAppApi({
      ...baseConfig(),
      googleOAuth: new InMemoryOAuthProvider(),
    });
    const res = await api.fetch(new Request("http://api.test/auth/google/start"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(IN_MEMORY_AUTHORIZE_URL);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0].startsWith("__Host-samo_oauth=")).toBe(true);
    // PROD composition: `Secure` is never stripped — a `__Host-` cookie without
    // it is DISCARDED by the browser.
    expect(cookies[0]).toContain("Secure");
  });

  it("DEV composition keeps `Secure` on the __Host- state cookie (never stripped)", async () => {
    const api = createAppApi({
      ...baseConfig(),
      googleOAuth: new InMemoryOAuthProvider(),
      devShortcuts,
    });
    const res = await api.fetch(new Request("http://api.test/auth/google/start"));
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain("Secure");
  });
});
