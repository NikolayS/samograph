import { describe, it, expect } from "bun:test";
import { SigningKeyring } from "./keyring.ts";
import { InMemoryEmailSender } from "./email.ts";
import { InMemoryMagicLinkStore, InMemoryUserStore, type UserStore } from "./stores.ts";
import { InMemoryRateLimiter } from "./rate-limit.ts";
import { verifySession } from "./session.ts";
import { AuthService } from "./service.ts";

const SESSION_SECRET = "svc-session-secret";

/**
 * A UserStore whose provisioning can be toggled to throw, simulating a transient
 * downstream failure (e.g. the prod RLS denial on `INSERT INTO tenants` behind
 * issue #180). While `healthy` is false, `createOrLoadUser` throws; flip it true
 * and it delegates to a real in-memory store.
 */
class ToggleableUserStore implements UserStore {
  healthy = false;
  readonly inner = new InMemoryUserStore();
  async createOrLoadUser(email: string) {
    if (!this.healthy) {
      throw new Error("provisioning failed: RLS denied INSERT INTO tenants");
    }
    return this.inner.createOrLoadUser(email);
  }
}

/** A service wired to in-memory fakes + a mutable clock; jti is deterministic. */
function makeService(
  overrides: { rateLimiter?: InMemoryRateLimiter; userStore?: UserStore } = {},
) {
  let now = Date.parse("2026-06-28T12:00:00.000Z");
  let n = 0;
  const emailSender = new InMemoryEmailSender();
  const linkStore = new InMemoryMagicLinkStore();
  const userStore = overrides.userStore ?? new InMemoryUserStore();
  const rateLimiter = overrides.rateLimiter ?? new InMemoryRateLimiter();
  const service = new AuthService({
    keyring: new SigningKeyring("k2", { k1: "old", k2: "new" }),
    emailSender,
    linkStore,
    userStore,
    rateLimiter,
    sessionSecret: SESSION_SECRET,
    clock: () => now,
    baseUrl: "https://samograph.dev",
    randomJti: () => `jti-${++n}`,
  });
  return {
    service,
    emailSender,
    linkStore,
    userStore,
    rateLimiter,
    advance: (ms: number) => {
      now += ms;
    },
    setNow: (ms: number) => {
      now = ms;
    },
  };
}

/** Pull the token out of the most recently "sent" magic-link email. */
function tokenFor(emailSender: InMemoryEmailSender, to: string): string {
  const sent = emailSender.lastFor(to);
  if (!sent) throw new Error("no email sent");
  return sent.token;
}

describe("AuthService.requestMagicLink", () => {
  it("sends a magic link via the EmailSender with a callback URL", async () => {
    const { service, emailSender } = makeService();
    const res = await service.requestMagicLink({ email: "User@Example.com", ip: "1.1.1.1" });
    expect(res).toEqual({ ok: true });
    expect(emailSender.sent.length).toBe(1);
    const sent = emailSender.sent[0];
    expect(sent.to).toBe("user@example.com"); // normalized
    expect(sent.link.startsWith("https://samograph.dev/auth/callback?token=")).toBe(true);
    expect(sent.link).toContain(encodeURIComponent(sent.token));
  });

  it("per-email 5/hr and per-IP 20/hr limits trip INDEPENDENTLY", async () => {
    // (a) per-email trips first: 6th request for one email from one IP → 429,
    //     even though that IP is only at 6 of 20.
    const a = makeService();
    for (let i = 0; i < 5; i++) {
      expect((await a.service.requestMagicLink({ email: "a@x.com", ip: "9.9.9.9" })).ok).toBe(true);
    }
    const blockedByEmail = await a.service.requestMagicLink({ email: "a@x.com", ip: "9.9.9.9" });
    expect(blockedByEmail).toEqual({
      ok: false,
      code: "SAMO-AUTH-004",
      retryAfterSec: 3600,
    });
    expect(a.emailSender.sent.length).toBe(5); // 6th never sent

    // (b) per-IP trips first: 20 DISTINCT emails from one IP all succeed (no
    //     email reaches 5), the 21st distinct email → 429 on the IP limit.
    const b = makeService();
    for (let i = 0; i < 20; i++) {
      expect(
        (await b.service.requestMagicLink({ email: `u${i}@x.com`, ip: "8.8.8.8" })).ok,
      ).toBe(true);
    }
    const blockedByIp = await b.service.requestMagicLink({ email: "u20@x.com", ip: "8.8.8.8" });
    expect(blockedByIp.ok).toBe(false);
    if (!blockedByIp.ok) expect(blockedByIp.code).toBe("SAMO-AUTH-004");
    expect(b.emailSender.sent.length).toBe(20);
  });

  // Issue #63: check-both-then-commit. A rejection on ONE independent limit must
  // NOT advance the OTHER limit's counter (no cross-limiter perturbation).
  const HOUR = 60 * 60 * 1000;
  const NOW = Date.parse("2026-06-28T12:00:00.000Z"); // == makeService clock

  it("a per-IP rejection does NOT advance the per-email counter", async () => {
    const rl = new InMemoryRateLimiter();
    // Saturate the per-IP limit (20/hr) for this IP.
    for (let i = 0; i < 20; i++) {
      expect((await rl.hit("ip:5.5.5.5", 20, HOUR, NOW)).allowed).toBe(true);
    }
    const { service, emailSender } = makeService({ rateLimiter: rl });

    // This request must be blocked by the IP limit...
    const res = await service.requestMagicLink({ email: "victim@x.com", ip: "5.5.5.5" });
    expect(res).toEqual({ ok: false, code: "SAMO-AUTH-004", retryAfterSec: 3600 });
    expect(emailSender.sent.length).toBe(0);

    // ...and it must leave victim's per-email counter UNTOUCHED. The first real
    // hit therefore reports full budget minus one → remaining 4 (buggy: 3).
    const afterEmail = await rl.hit("email:victim@x.com", 5, HOUR, NOW);
    expect(afterEmail.remaining).toBe(4);
  });

  it("a per-email rejection does NOT advance the per-IP counter (symmetric)", async () => {
    const rl = new InMemoryRateLimiter();
    // Saturate the per-email limit (5/hr) for this email.
    for (let i = 0; i < 5; i++) {
      expect((await rl.hit("email:heavy@x.com", 5, HOUR, NOW)).allowed).toBe(true);
    }
    const { service, emailSender } = makeService({ rateLimiter: rl });

    const res = await service.requestMagicLink({ email: "heavy@x.com", ip: "4.4.4.4" });
    expect(res).toEqual({ ok: false, code: "SAMO-AUTH-004", retryAfterSec: 3600 });
    expect(emailSender.sent.length).toBe(0);

    // The per-IP counter must be UNTOUCHED: full 20 budget → first hit remaining 19.
    const afterIp = await rl.hit("ip:4.4.4.4", 20, HOUR, NOW);
    expect(afterIp.remaining).toBe(19);
  });

  it("after an IP-triggered rejection, the SAME email still has its FULL budget", async () => {
    const rl = new InMemoryRateLimiter();
    // Saturate the per-IP limit for one IP.
    for (let i = 0; i < 20; i++) {
      expect((await rl.hit("ip:3.3.3.3", 20, HOUR, NOW)).allowed).toBe(true);
    }
    const { service } = makeService({ rateLimiter: rl });

    // Blocked by the IP limit — must not steal an email slot.
    const blocked = await service.requestMagicLink({ email: "same@x.com", ip: "3.3.3.3" });
    expect(blocked.ok).toBe(false);

    // The SAME email, now from a clean IP, must get its full 5 successes.
    let ok = 0;
    for (let i = 0; i < 6; i++) {
      const r = await service.requestMagicLink({ email: "same@x.com", ip: "2.2.2.2" });
      if (r.ok) ok++;
    }
    expect(ok).toBe(5); // buggy: 4 (the blocked request already spent one slot)
  });
});

describe("AuthService.callback", () => {
  it("GREEN: a fresh valid link sets a signed session cookie + creates user & tenant", async () => {
    const { service, emailSender, userStore } = makeService();
    await service.requestMagicLink({ email: "new@example.com", ip: "1.1.1.1" });
    const token = tokenFor(emailSender, "new@example.com");

    const res = await service.callback(token);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.errorCode).toBeUndefined();
    expect(res.setCookie).toBeDefined();
    expect(res.setCookie).toContain("HttpOnly");
    expect(res.setCookie).toContain("Secure");
    expect(res.setCookie).toContain("SameSite=Lax");

    // user + 1:1 tenant created
    expect(userStore.users.size).toBe(1);
    const user = res.user!;
    expect(user.email).toBe("new@example.com");
    expect(user.tenantId).toBeTruthy();

    // the cookie really carries this user's session
    const value = res.setCookie!.split("=")[1].split(";")[0];
    // Pin `now` to the service clock so the assertion is not gated by the #57
    // server-side session TTL as the wall clock advances past this fixed iat.
    expect(verifySession(value, SESSION_SECRET, Date.parse("2026-06-28T12:00:00.000Z"))).toEqual({
      userId: user.id,
      tenantId: user.tenantId,
      iat: Date.parse("2026-06-28T12:00:00.000Z"),
    });
  });

  it("replay after consume → 401 SAMO-AUTH-003 with no cookie", async () => {
    const { service, emailSender } = makeService();
    await service.requestMagicLink({ email: "r@example.com", ip: "1.1.1.1" });
    const token = tokenFor(emailSender, "r@example.com");

    expect((await service.callback(token)).ok).toBe(true);
    const replay = await service.callback(token);
    expect(replay.ok).toBe(false);
    expect(replay.status).toBe(401);
    expect(replay.errorCode).toBe("SAMO-AUTH-003");
    expect(replay.setCookie).toBeUndefined();
  });

  it("expired link (clicked 14:59, consumed 15:01) → 401 SAMO-AUTH-002", async () => {
    const s = makeService();
    s.setNow(Date.parse("2026-06-28T14:46:00.000Z")); // exp = 15:01:00
    await s.service.requestMagicLink({ email: "ttl@example.com", ip: "1.1.1.1" });
    const token = tokenFor(s.emailSender, "ttl@example.com");

    s.setNow(Date.parse("2026-06-28T15:01:00.000Z"));
    const res = await s.service.callback(token);
    expect(res.status).toBe(401);
    expect(res.errorCode).toBe("SAMO-AUTH-002");
  });

  it("two concurrent links per email: only the NEWEST verifies; older → 401", async () => {
    const { service, emailSender } = makeService();
    await service.requestMagicLink({ email: "two@example.com", ip: "1.1.1.1" });
    const first = tokenFor(emailSender, "two@example.com");
    await service.requestMagicLink({ email: "two@example.com", ip: "1.1.1.1" });
    const second = tokenFor(emailSender, "two@example.com");
    expect(first).not.toBe(second);

    // The older link was invalidated server-side at issue time of the newer.
    // A superseded link is an "already used"-class outcome (SAMO-AUTH-003), NOT
    // the generic invalid/tampered SAMO-AUTH-001 — issue #180 splits it out so
    // the web can show the honest "already used" copy instead of "isn't valid".
    const older = await service.callback(first);
    expect(older.ok).toBe(false);
    expect(older.status).toBe(401);
    expect(older.errorCode).toBe("SAMO-AUTH-003");

    const newer = await service.callback(second);
    expect(newer.ok).toBe(true);
    expect(newer.status).toBe(200);
  });

  it("provisioning failure leaves the link OUTSTANDING; a retry after recovery signs in", async () => {
    // issue #180 (a): the callback must PROVISION the user/tenant BEFORE consuming
    // the single-use link, so a transient provisioning failure does NOT burn the
    // link. The same token must still sign in once the store recovers.
    const userStore = new ToggleableUserStore();
    const { service, emailSender, linkStore } = makeService({ userStore });
    await service.requestMagicLink({ email: "flaky@example.com", ip: "1.1.1.1" });
    const token = tokenFor(emailSender, "flaky@example.com");

    // First click while provisioning is down → mapped failure, link untouched.
    const failed = await service.callback(token);
    expect(failed.ok).toBe(false);
    expect(failed.setCookie).toBeUndefined();
    // The single-use link is still OUTSTANDING (never consumed) → retryable.
    const rec = await linkStore.get("jti-1");
    expect(rec?.status).toBe("outstanding");

    // Store recovers; the SAME token now signs in with a real session.
    userStore.healthy = true;
    const ok = await service.callback(token);
    expect(ok.ok).toBe(true);
    expect(ok.status).toBe(200);
    expect(ok.setCookie).toBeDefined();
    expect(ok.user?.email).toBe("flaky@example.com");
  });

  it("an infra/provisioning failure resolves to a mapped SAMO-AUTH-500, not an unhandled throw", async () => {
    // issue #180 (a): a downstream failure must resolve to a mapped 5xx code, not
    // escape as an unhandled throw / raw 500 with no auth code.
    const userStore = new ToggleableUserStore(); // stays unhealthy → always throws
    const { service, emailSender } = makeService({ userStore });
    await service.requestMagicLink({ email: "infra@example.com", ip: "1.1.1.1" });
    const token = tokenFor(emailSender, "infra@example.com");

    const res = await service.callback(token);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(res.errorCode).toBe("SAMO-AUTH-500");
    expect(res.setCookie).toBeUndefined();
  });

  it("tampered KID → 401 SAMO-AUTH-001", async () => {
    const { service, emailSender } = makeService();
    await service.requestMagicLink({ email: "kid@example.com", ip: "1.1.1.1" });
    const token = tokenFor(emailSender, "kid@example.com");
    const [payloadB64, sig] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    payload.kid = "k-attacker";
    const tampered = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    const res = await service.callback(tampered);
    expect(res.status).toBe(401);
    expect(res.errorCode).toBe("SAMO-AUTH-001");
  });

  it("signature mismatch → 401 SAMO-AUTH-001", async () => {
    const { service, emailSender } = makeService();
    await service.requestMagicLink({ email: "sig@example.com", ip: "1.1.1.1" });
    const token = tokenFor(emailSender, "sig@example.com");
    const [payloadB64] = token.split(".");
    const forged = `${payloadB64}.${Buffer.from("not-the-real-signature").toString("base64url")}`;
    const res = await service.callback(forged);
    expect(res.status).toBe(401);
    expect(res.errorCode).toBe("SAMO-AUTH-001");
  });
});
