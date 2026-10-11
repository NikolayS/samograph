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
  ReadCaps,
  readCapKey,
  READ_MAX_CONCURRENT,
  RequestRateCaps,
  REST_REQUESTS_PER_WINDOW,
  REST_REQUEST_WINDOW_MS,
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

// ── Read-scope concurrent cap — pure limiter (SPEC §5.7, §8) ─────────────────
describe("read caps — per-(session, call) concurrent cap (§5.7, §8)", () => {
  it("pins the spec number: 10 concurrent read connections per session per call", () => {
    expect(READ_MAX_CONCURRENT).toBe(10);
  });

  it("admits up to the cap and rejects the (cap+1)th; a DENY records nothing", () => {
    const cap = 3;
    const caps = new ReadCaps(cap);
    const key = readCapKey("session-cookie-A", "call-1");
    for (let i = 1; i <= cap; i++) {
      const d = caps.tryEstablish(key);
      expect(d.allowed).toBe(true);
      expect(caps.concurrent(key)).toBe(i);
    }
    // The (cap+1)th is denied with a positive back-off and does NOT inflate the count.
    const over = caps.tryEstablish(key);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterMs).toBeGreaterThan(0);
    expect(caps.concurrent(key)).toBe(cap);
  });

  it("closing one connection frees exactly one slot", () => {
    const caps = new ReadCaps(1);
    const key = readCapKey("session-cookie-A", "call-1");
    expect(caps.tryEstablish(key).allowed).toBe(true);
    expect(caps.tryEstablish(key).allowed).toBe(false); // full at 1
    caps.release(key);
    expect(caps.concurrent(key)).toBe(0);
    expect(caps.tryEstablish(key).allowed).toBe(true); // slot freed → admitted again
  });

  it("is keyed per (session, call): a different session OR a different call has its own budget", () => {
    const caps = new ReadCaps(1);
    const keyA1 = readCapKey("session-A", "call-1");
    const keyB1 = readCapKey("session-B", "call-1"); // different session, same call
    const keyA2 = readCapKey("session-A", "call-2"); // same session, different call
    expect(caps.tryEstablish(keyA1).allowed).toBe(true);
    expect(caps.tryEstablish(keyA1).allowed).toBe(false); // A/call-1 is now full
    expect(caps.tryEstablish(keyB1).allowed).toBe(true); // a different session is unaffected
    expect(caps.tryEstablish(keyA2).allowed).toBe(true); // a different call is unaffected
  });

  it("readCapKey binds the session cookie to the call id (distinct keys per pair)", () => {
    expect(readCapKey("s", "c1")).not.toBe(readCapKey("s", "c2"));
    expect(readCapKey("s1", "c")).not.toBe(readCapKey("s2", "c"));
    // Stable: same inputs → same key.
    expect(readCapKey("s", "c1")).toBe(readCapKey("s", "c1"));
  });

  it("release() is idempotent at zero (never goes negative)", () => {
    const caps = new ReadCaps(2);
    const key = readCapKey("s", "c");
    caps.release(key);
    caps.release(key);
    expect(caps.concurrent(key)).toBe(0);
  });
});

// ── REST request-rate cap — the REST-surface analogue of the WS caps (§5.7, §5.16) ──
describe("REST request-rate cap (RequestRateCaps) — exact sliding-window bounds", () => {
  it("pins the generous defaults (120 requests / 60 s)", () => {
    expect(REST_REQUESTS_PER_WINDOW).toBe(120);
    expect(REST_REQUEST_WINDOW_MS).toBe(60_000);
  });

  it("admits exactly `perWindow` requests, then denies with SAMO-RATE-001 back-off", () => {
    const caps = new RequestRateCaps({ perWindow: 3, windowMs: 60_000 });
    const key = shareCapKey("tok");
    const now = 1_000_000;
    expect(caps.tryRequest(key, now).allowed).toBe(true); // 1
    expect(caps.tryRequest(key, now).allowed).toBe(true); // 2
    expect(caps.tryRequest(key, now).allowed).toBe(true); // 3 — the last admitted
    const over = caps.tryRequest(key, now); // 4th → denied
    expect(over.allowed).toBe(false);
    // Back-off = the oldest hit's age-out: first ts (now) + window − now = window.
    expect(over.retryAfterMs).toBe(60_000);
  });

  it("the window SLIDES: a denied request frees as the oldest ages out (no slot consumed on DENY)", () => {
    const caps = new RequestRateCaps({ perWindow: 1, windowMs: 1_000 });
    const key = shareCapKey("tok");
    expect(caps.tryRequest(key, 0).allowed).toBe(true); // fills the 1-slot window
    expect(caps.tryRequest(key, 500).allowed).toBe(false); // still inside the window
    // A DENY records nothing, so once the first hit ages out the budget is back.
    expect(caps.tryRequest(key, 1_001).allowed).toBe(true);
  });

  it("is keyed strictly per key: one token hitting its cap never touches another (share vs read)", () => {
    const caps = new RequestRateCaps({ perWindow: 1, windowMs: 60_000 });
    const shareKey = shareCapKey("leaked-token");
    const readKey = readCapKey("session-A", "call-1");
    const now = 0;
    expect(caps.tryRequest(shareKey, now).allowed).toBe(true);
    expect(caps.tryRequest(shareKey, now).allowed).toBe(false); // share token is now full
    // A different key (a read session, or another token) has its own full budget.
    expect(caps.tryRequest(readKey, now).allowed).toBe(true);
    expect(caps.tryRequest(shareCapKey("other-token"), now).allowed).toBe(true);
  });
});
