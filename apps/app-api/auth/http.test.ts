import { describe, it, expect } from "bun:test";
import { SigningKeyring } from "./keyring.ts";
import { InMemoryEmailSender } from "./email.ts";
import { InMemoryMagicLinkStore, InMemoryUserStore } from "./stores.ts";
import { InMemoryRateLimiter } from "./rate-limit.ts";
import { AuthService } from "./service.ts";
import { clientIp, createAuthHandler } from "./http.ts";

function makeHandler() {
  let now = Date.parse("2026-06-28T12:00:00.000Z");
  const emailSender = new InMemoryEmailSender();
  let n = 0;
  const service = new AuthService({
    keyring: new SigningKeyring("k2", { k2: "new" }),
    emailSender,
    linkStore: new InMemoryMagicLinkStore(),
    userStore: new InMemoryUserStore(),
    rateLimiter: new InMemoryRateLimiter(),
    sessionSecret: "http-secret",
    clock: () => now,
    baseUrl: "https://samograph.dev",
    randomJti: () => `jti-${++n}`,
  });
  return { handler: createAuthHandler(service), emailSender };
}

const post = (email: unknown, ip = "5.5.5.5") =>
  new Request("https://samograph.dev/auth/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` },
    body: JSON.stringify({ email }),
  });

describe("auth/http — clientIp", () => {
  it("takes the first hop of X-Forwarded-For", () => {
    const req = new Request("https://x/", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } });
    expect(clientIp(req)).toBe("203.0.113.7");
  });
  it("falls back to 'unknown' when no forwarding header is present", () => {
    expect(clientIp(new Request("https://x/"))).toBe("unknown");
  });
});

describe("auth/http — POST /auth/magic-link", () => {
  it("returns 200 and sends the link on success", async () => {
    const { handler, emailSender } = makeHandler();
    const res = await handler(post("a@example.com"));
    expect(res.status).toBe(200);
    expect(emailSender.sent.length).toBe(1);
    expect(emailSender.sent[0].to).toBe("a@example.com");
  });

  it("returns 429 + Retry-After + SAMO-AUTH-004 body when rate limited", async () => {
    const { handler } = makeHandler();
    for (let i = 0; i < 5; i++) await handler(post("a@example.com", "7.7.7.7"));
    const res = await handler(post("a@example.com", "7.7.7.7"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3600");
    const body = await res.json();
    expect(body).toEqual({
      code: "SAMO-AUTH-004",
      message: "Too many sign-in attempts — try again shortly.",
      retryable: true,
    });
  });

  it("returns 400 when the email field is missing", async () => {
    const { handler } = makeHandler();
    const res = await handler(post(undefined));
    expect(res.status).toBe(400);
  });
});

describe("auth/http — GET /auth/callback", () => {
  it("sets the session cookie on success (HttpOnly; Secure; SameSite=Lax)", async () => {
    const { handler, emailSender } = makeHandler();
    await handler(post("ok@example.com"));
    const token = emailSender.sent[0].token;
    const res = await handler(
      new Request(`https://samograph.dev/auth/callback?token=${encodeURIComponent(token)}`),
    );
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie.startsWith("samo_session=")).toBe(true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("returns 401 with NO body and NO cookie on replay", async () => {
    const { handler, emailSender } = makeHandler();
    await handler(post("rp@example.com"));
    const token = emailSender.sent[0].token;
    const url = `https://samograph.dev/auth/callback?token=${encodeURIComponent(token)}`;
    await handler(new Request(url)); // first use consumes it
    const res = await handler(new Request(url)); // replay
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe("");
  });

  it("returns 401 with no body when the token is missing or junk", async () => {
    const { handler } = makeHandler();
    const missing = await handler(new Request("https://samograph.dev/auth/callback"));
    expect(missing.status).toBe(401);
    expect(await missing.text()).toBe("");
    const junk = await handler(
      new Request("https://samograph.dev/auth/callback?token=garbage"),
    );
    expect(junk.status).toBe(401);
    expect(await junk.text()).toBe("");
  });
});

describe("auth/http — routing", () => {
  it("404s an unknown path", async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request("https://samograph.dev/nope"));
    expect(res.status).toBe(404);
  });
});
