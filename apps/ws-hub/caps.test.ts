/**
 * Share-scope numeric caps — pure limiter tests (SPEC §5.7, §6.2 #10, §5.16).
 *
 * Strict red/green TDD with EXACT boundary assertions (written BEFORE ./caps.ts):
 *   • per-token concurrent cap = 200 (200th ok, 201st → 429; closing frees a slot)
 *   • per-connection command rate = 20 / 60 s (20th ok, 21st → 429; window resets)
 *   • per-token establishment rate = 1000 / hour (1000th ok, 1001st → 429)
 *   • per-token / per-connection ISOLATION (one key hitting its cap never touches
 *     another) — the `read`-vs-`share` separation lives in the stream wiring, but
 *     the limiter itself must key strictly per token / per connection.
 * Over-cap → `SAMO-RATE-001`, 429, Retry-After honored (§5.16).
 *
 * Pure + always-run (no DB): the heavy 200/1000-iteration boundaries are in-memory
 * and deterministic, so the exact numbers are asserted at the exact count.
 */
import { describe, it, expect } from "bun:test";
import {
  ShareCaps,
  shareCapKey,
  rateLimitedResponse,
  SHARE_MAX_CONCURRENT,
  SHARE_COMMANDS_PER_WINDOW,
  SHARE_COMMAND_WINDOW_MS,
  SHARE_ESTABLISH_PER_WINDOW,
  SHARE_ESTABLISH_WINDOW_MS,
  RATE_LIMIT_ERROR_CODE,
} from "./caps.ts";

describe("share caps — exact numeric defaults (§5.7)", () => {
  it("pins the spec's numbers: 200 concurrent / 20 cmds-per-min / 1000 establishments-per-hr", () => {
    expect(SHARE_MAX_CONCURRENT).toBe(200);
    expect(SHARE_COMMANDS_PER_WINDOW).toBe(20);
    expect(SHARE_COMMAND_WINDOW_MS).toBe(60_000);
    expect(SHARE_ESTABLISH_PER_WINDOW).toBe(1000);
    expect(SHARE_ESTABLISH_WINDOW_MS).toBe(60 * 60 * 1000);
    expect(RATE_LIMIT_ERROR_CODE).toBe("SAMO-RATE-001");
  });
});

describe("per-token concurrent-connection cap = 200 (201st → 429)", () => {
  it("admits exactly 200 concurrent, denies the 201st, then a release frees one slot", () => {
    const caps = new ShareCaps();
    const t = 1_000;

    // The first 200 establishments all succeed (concurrent rises 1..200).
    let admitted = 0;
    for (let i = 0; i < SHARE_MAX_CONCURRENT; i++) {
      const d = caps.tryEstablish("tokenA", t);
      expect(d.allowed).toBe(true);
      admitted++;
    }
    expect(admitted).toBe(200);
    expect(caps.concurrent("tokenA")).toBe(200);

    // The 201st concurrent connection is rejected with a positive Retry-After.
    const over = caps.tryEstablish("tokenA", t);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterMs).toBeGreaterThan(0);
    expect(caps.concurrent("tokenA")).toBe(200); // a denied attempt does NOT consume a slot

    // Closing one connection frees exactly one slot → the next establish succeeds.
    caps.release("tokenA");
    expect(caps.concurrent("tokenA")).toBe(199);
    const afterRelease = caps.tryEstablish("tokenA", t);
    expect(afterRelease.allowed).toBe(true);
    expect(caps.concurrent("tokenA")).toBe(200);
  });
});

describe("per-connection command rate = 20 / 60 s (21st → 429, window resets)", () => {
  it("admits exactly 20 commands in the window, denies the 21st, then resets after 60 s", () => {
    const caps = new ShareCaps();
    const t0 = 5_000;

    for (let i = 0; i < SHARE_COMMANDS_PER_WINDOW; i++) {
      expect(caps.tryCommand("conn-1", t0).allowed).toBe(true);
    }
    const twentyFirst = caps.tryCommand("conn-1", t0);
    expect(twentyFirst.allowed).toBe(false);
    expect(twentyFirst.retryAfterMs).toBeGreaterThan(0);

    // Still capped one ms before the window closes.
    expect(caps.tryCommand("conn-1", t0 + SHARE_COMMAND_WINDOW_MS - 1).allowed).toBe(false);
    // One ms past the window, the oldest hits age out → a command is admitted again.
    expect(caps.tryCommand("conn-1", t0 + SHARE_COMMAND_WINDOW_MS + 1).allowed).toBe(true);
  });

  it("command rate is PER CONNECTION: a second connection has its own fresh budget", () => {
    const caps = new ShareCaps();
    const t = 7_000;
    for (let i = 0; i < SHARE_COMMANDS_PER_WINDOW; i++) caps.tryCommand("conn-A", t);
    expect(caps.tryCommand("conn-A", t).allowed).toBe(false); // A is capped
    expect(caps.tryCommand("conn-B", t).allowed).toBe(true); // B is unaffected
  });
});

describe("per-token establishment rate = 1000 / hour (1001st → 429)", () => {
  it("admits exactly 1000 establishments in the hour, denies the 1001st", () => {
    const caps = new ShareCaps();
    const t = 9_000;

    // Connect-then-disconnect churn (anti-fuzz): release each so the CONCURRENT cap
    // is never the limiter — this isolates the establishment-rate cap.
    for (let i = 0; i < SHARE_ESTABLISH_PER_WINDOW; i++) {
      expect(caps.tryEstablish("tokenC", t).allowed).toBe(true);
      caps.release("tokenC");
    }
    const thousandFirst = caps.tryEstablish("tokenC", t);
    expect(thousandFirst.allowed).toBe(false);
    expect(thousandFirst.retryAfterMs).toBeGreaterThan(0);

    // One hour later the window has slid → establishment is admitted again.
    expect(caps.tryEstablish("tokenC", t + SHARE_ESTABLISH_WINDOW_MS + 1).allowed).toBe(true);
  });
});

describe("isolation — one key hitting its cap never affects another", () => {
  it("token concurrent cap is per-token: capping tokenA leaves tokenB fully open", () => {
    const caps = new ShareCaps();
    const t = 11_000;
    for (let i = 0; i < SHARE_MAX_CONCURRENT; i++) caps.tryEstablish("tokenA", t);
    expect(caps.tryEstablish("tokenA", t).allowed).toBe(false); // A is full
    expect(caps.tryEstablish("tokenB", t).allowed).toBe(true); // B is independent
    expect(caps.concurrent("tokenB")).toBe(1);
  });

  it("token establishment cap is per-token: capping tokenA leaves tokenB open", () => {
    const caps = new ShareCaps();
    const t = 13_000;
    for (let i = 0; i < SHARE_ESTABLISH_PER_WINDOW; i++) {
      caps.tryEstablish("tokenA", t);
      caps.release("tokenA");
    }
    expect(caps.tryEstablish("tokenA", t).allowed).toBe(false);
    expect(caps.tryEstablish("tokenB", t).allowed).toBe(true);
  });
});

describe("shareCapKey — stable per-token identity, never the raw secret", () => {
  it("is deterministic per token, distinct across tokens, and not the token itself", () => {
    const a = shareCapKey("share.token.AAA");
    const a2 = shareCapKey("share.token.AAA");
    const b = shareCapKey("share.token.BBB");
    expect(a).toBe(a2); // same token → same key
    expect(a).not.toBe(b); // different token → different key
    expect(a).not.toBe("share.token.AAA"); // hashed — the raw token is not the key
    expect(a).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });
});

describe("rateLimitedResponse — 429 + Retry-After + typed SAMO-RATE-001 body (§5.16)", () => {
  it("renders a 429 with Retry-After seconds (min 1) and a retryable typed body", async () => {
    const res = rateLimitedResponse(2_500);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3"); // ceil(2500ms / 1000) = 3 s
    const body = (await res.json()) as { code: string; retryable: boolean };
    expect(body.code).toBe(RATE_LIMIT_ERROR_CODE);
    expect(body.retryable).toBe(true);

    // Sub-second waits still surface a Retry-After of at least 1 second.
    expect(rateLimitedResponse(10).headers.get("Retry-After")).toBe("1");
  });
});
