import { describe, it, expect } from "bun:test";
import { base64url, fromBase64url, hmacSha256, constantTimeEqual } from "./crypto.ts";

describe("auth/crypto", () => {
  it("base64url round-trips bytes exactly, URL-safe and unpadded", () => {
    // 0xfb 0xff 0xbf encodes to "-_+/" alphabet territory: must use - and _, no =.
    const raw = Buffer.from([0xfb, 0xff, 0xbf, 0x00, 0x10]);
    const enc = base64url(raw);
    expect(enc).toBe("-_-_ABA");
    expect(enc).not.toContain("=");
    expect(enc).not.toContain("+");
    expect(enc).not.toContain("/");
    expect([...fromBase64url(enc)]).toEqual([...raw]);
  });

  it("base64url encodes a UTF-8 string", () => {
    expect(base64url("hello")).toBe("aGVsbG8");
    expect(fromBase64url("aGVsbG8").toString("utf8")).toBe("hello");
  });

  it("hmacSha256 is deterministic, 32 bytes, and key-dependent", () => {
    const a = hmacSha256("secret-k1", "the-message");
    const b = hmacSha256("secret-k1", "the-message");
    const c = hmacSha256("secret-k2", "the-message");
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true); // deterministic
    expect(a.equals(c)).toBe(false); // different key → different MAC
    // Exact known-answer vector pins the algorithm to HMAC-SHA256.
    expect(a.toString("hex")).toBe(
      "72d6d6f2282a1c7412f676e82c1539f171a609c5b7c99a8b8851cb9ab0445e30",
    );
  });

  it("constantTimeEqual is true for equal buffers, false otherwise", () => {
    const x = Buffer.from("abcdef0123456789", "hex");
    const y = Buffer.from("abcdef0123456789", "hex");
    const z = Buffer.from("abcdef0123456788", "hex"); // last nibble differs
    expect(constantTimeEqual(x, y)).toBe(true);
    expect(constantTimeEqual(x, z)).toBe(false);
  });

  it("constantTimeEqual returns false (no throw) for unequal lengths", () => {
    expect(constantTimeEqual(Buffer.from("aa", "hex"), Buffer.from("aabb", "hex"))).toBe(
      false,
    );
  });

  // §6.2 #6: "timing-safe comparison on /auth/callback (statistical timing test)".
  // Methodology: over a long buffer, compare the wall-clock cost of rejecting a
  // value that differs in the FIRST byte vs one that differs in the LAST byte,
  // interleaved to cancel drift, median over many iterations. A constant-time
  // comparator scans the whole buffer either way → ratio ≈ 1. A byte-by-byte
  // early-exit comparator would make the late-diff case ~thousands× slower.
  it("constantTimeEqual cost is independent of first-diff position (statistical)", () => {
    const N = 8192;
    const base = Buffer.alloc(N, 0x41);
    const earlyDiff = Buffer.from(base);
    earlyDiff[0] ^= 0xff; // differs at byte 0
    const lateDiff = Buffer.from(base);
    lateDiff[N - 1] ^= 0xff; // differs at the final byte

    const ITERS = 4000;
    // Warm up the JIT on both shapes.
    for (let i = 0; i < ITERS; i++) {
      constantTimeEqual(base, earlyDiff);
      constantTimeEqual(base, lateDiff);
    }

    const earlySamples: number[] = [];
    const lateSamples: number[] = [];
    for (let i = 0; i < ITERS; i++) {
      let t = Bun.nanoseconds();
      constantTimeEqual(base, earlyDiff);
      earlySamples.push(Bun.nanoseconds() - t);
      t = Bun.nanoseconds();
      constantTimeEqual(base, lateDiff);
      lateSamples.push(Bun.nanoseconds() - t);
    }
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const early = median(earlySamples);
    const late = median(lateSamples);
    const ratio = late / Math.max(early, 1);

    // Both rejected (correctness), and the timing ratio is bounded well below
    // what an early-exit comparator over 8 KB would produce (~N×).
    expect(constantTimeEqual(base, earlyDiff)).toBe(false);
    expect(constantTimeEqual(base, lateDiff)).toBe(false);
    expect(early).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(3);
  });
});
