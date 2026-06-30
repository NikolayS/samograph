import { describe, expect, test } from "bun:test";
import { aggregateFunnel, FUNNEL_STAGES, type ActivationEvent } from "./funnel.ts";

/**
 * §5.11 activation funnel (§9: W1 activation is THE single v1 metric).
 *
 * Funnel stages, in order: signup → magic-link clicked → call created →
 * first transcript line (`first_line_at`, §5.2) → 30 s of stream (keyed off
 * Recall `in_call_recording` + ≥30 s stream, NOT first line, per §9).
 *
 * The aggregator is a classic cumulative funnel: a user is counted at every
 * stage up to and including the FURTHEST stage they reached. So a user who is
 * admitted but watches < 30 s is counted at their correct earlier stage and
 * NOT at `streamed_30s`; a silent call (admitted + ≥30 s but no transcript line)
 * still counts at `first_line` by the monotonic funnel convention.
 */
describe("aggregateFunnel — §5.11 / §9", () => {
  // Exact synthetic fixture with a user (u3) who joins but never reaches 30 s,
  // and a silent call (u7) that reaches 30 s with no first transcript line.
  const fixture: ActivationEvent[] = [
    // u1, u2 — fully activated.
    { userId: "u1", stage: "signup" },
    { userId: "u1", stage: "magic_link_clicked" },
    { userId: "u1", stage: "call_created" },
    { userId: "u1", stage: "first_line" },
    { userId: "u1", stage: "streamed_30s" },
    { userId: "u2", stage: "signup" },
    { userId: "u2", stage: "magic_link_clicked" },
    { userId: "u2", stage: "call_created" },
    { userId: "u2", stage: "first_line" },
    { userId: "u2", stage: "streamed_30s" },
    // u3 — admitted, saw a line, but never reached 30 s (furthest = first_line).
    { userId: "u3", stage: "signup" },
    { userId: "u3", stage: "magic_link_clicked" },
    { userId: "u3", stage: "call_created" },
    { userId: "u3", stage: "first_line" },
    // u4 — created a call, bot never produced a line (furthest = call_created).
    { userId: "u4", stage: "signup" },
    { userId: "u4", stage: "magic_link_clicked" },
    { userId: "u4", stage: "call_created" },
    // u5 — clicked the magic link, never created a call.
    { userId: "u5", stage: "signup" },
    { userId: "u5", stage: "magic_link_clicked" },
    // u6 — signed up only.
    { userId: "u6", stage: "signup" },
    // u7 — silent call: signup→magic→call→30 s of stream, NO first_line event.
    { userId: "u7", stage: "signup" },
    { userId: "u7", stage: "magic_link_clicked" },
    { userId: "u7", stage: "call_created" },
    { userId: "u7", stage: "streamed_30s" },
  ];

  test("returns exact cumulative stage counts", () => {
    const snap = aggregateFunnel(fixture);
    expect(snap.stageCounts).toEqual({
      signup: 7,
      magic_link_clicked: 6,
      call_created: 5,
      first_line: 4, // u1,u2,u3 + u7 (silent call counts here by monotonic rule)
      streamed_30s: 3, // u1,u2,u7
    });
  });

  test("computes total / activated / W1 fraction exactly", () => {
    const snap = aggregateFunnel(fixture);
    expect(snap.total).toBe(7);
    expect(snap.activated).toBe(3);
    expect(snap.w1Fraction).toBeCloseTo(3 / 7, 12);
  });

  test("a user who joins but never reaches 30 s is counted at the earlier stage", () => {
    const snap = aggregateFunnel(fixture);
    // u3 contributes to first_line but not to streamed_30s.
    expect(snap.stageCounts.first_line).toBe(4);
    expect(snap.stageCounts.streamed_30s).toBe(3);
  });

  test("empty stream → all zeros, W1 = 0 (no NaN)", () => {
    const snap = aggregateFunnel([]);
    for (const stage of FUNNEL_STAGES) expect(snap.stageCounts[stage]).toBe(0);
    expect(snap.total).toBe(0);
    expect(snap.activated).toBe(0);
    expect(snap.w1Fraction).toBe(0);
  });

  test("event order does not matter (furthest stage wins)", () => {
    const shuffled = [...fixture].reverse();
    expect(aggregateFunnel(shuffled)).toEqual(aggregateFunnel(fixture));
  });

  test("duplicate events for the same stage do not double-count", () => {
    const dups: ActivationEvent[] = [
      { userId: "a", stage: "signup" },
      { userId: "a", stage: "signup" },
      { userId: "a", stage: "magic_link_clicked" },
      { userId: "a", stage: "magic_link_clicked" },
    ];
    const snap = aggregateFunnel(dups);
    expect(snap.total).toBe(1);
    expect(snap.stageCounts.magic_link_clicked).toBe(1);
    expect(snap.activated).toBe(0);
  });
});
