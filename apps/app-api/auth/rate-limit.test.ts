import { describe, it, expect } from "bun:test";
import { InMemoryRateLimiter } from "./rate-limit.ts";

const HOUR = 60 * 60 * 1000;

describe("auth/rate-limit — InMemoryRateLimiter", () => {
  it("allows exactly `limit` hits per window, blocks the next, with Retry-After", async () => {
    const rl = new InMemoryRateLimiter();
    const now = 1_000_000;
    for (let i = 1; i <= 5; i++) {
      const d = await rl.hit("email:a@x.com", 5, HOUR, now);
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(5 - i);
    }
    const sixth = await rl.hit("email:a@x.com", 5, HOUR, now);
    expect(sixth.allowed).toBe(false);
    expect(sixth.remaining).toBe(0);
    // The earliest hit was at `now`; the window frees up one hour later.
    expect(sixth.retryAfterMs).toBe(HOUR);
  });

  it("is a sliding window: hits older than the window no longer count", async () => {
    const rl = new InMemoryRateLimiter();
    for (let i = 0; i < 5; i++) await rl.hit("email:a@x.com", 5, HOUR, 0);
    // At exactly +1h the first 5 (at t=0) have aged out → allowed again.
    const d = await rl.hit("email:a@x.com", 5, HOUR, HOUR);
    expect(d.allowed).toBe(true);
  });

  it("blocked attempts do NOT consume a slot (counter is not inflated)", async () => {
    const rl = new InMemoryRateLimiter();
    const now = 5;
    for (let i = 0; i < 5; i++) await rl.hit("email:a@x.com", 5, HOUR, now);
    await rl.hit("email:a@x.com", 5, HOUR, now); // blocked
    await rl.hit("email:a@x.com", 5, HOUR, now); // blocked
    // Once the original 5 age out, exactly 5 are allowed again — no carry-over.
    let allowed = 0;
    for (let i = 0; i < 7; i++) {
      const d = await rl.hit("email:a@x.com", 5, HOUR, now + HOUR + 1);
      if (d.allowed) allowed++;
    }
    expect(allowed).toBe(5);
  });

  it("counters for different keys are independent", async () => {
    const rl = new InMemoryRateLimiter();
    const now = 42;
    // 5 distinct emails each used once: none trips its own 5/hr limit.
    for (let i = 0; i < 5; i++) {
      const d = await rl.hit(`email:user${i}@x.com`, 5, HOUR, now);
      expect(d.allowed).toBe(true);
    }
    // The SAME ip key accumulates across all of them.
    for (let i = 0; i < 20; i++) {
      expect((await rl.hit("ip:1.2.3.4", 20, HOUR, now)).allowed).toBe(true);
    }
    expect((await rl.hit("ip:1.2.3.4", 20, HOUR, now)).allowed).toBe(false);
  });
});
