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
import { InMemoryEmailSender } from "./auth/index.ts";

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

/** The exact dev shortcuts the dev wrapper injects. */
const devShortcuts: DevShortcuts = {
  lastMagicLink: () => Response.json({ ok: true, link: "http://web.test/auth/callback?token=x" }, { status: 200 }),
  stripSecureCookie: (res) => {
    const sc = res.headers.get("set-cookie");
    if (!sc) return res;
    const headers = new Headers(res.headers);
    headers.set("set-cookie", sc.replace(/;\s*Secure/gi, ""));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
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
