import { describe, expect, test } from "bun:test";
import {
  aggregateFunnel,
  DEFAULT_SIGNUP_METHOD,
  FUNNEL_STAGES,
  SIGNUP_METHODS,
  type ActivationEvent,
} from "./funnel.ts";

/**
 * §5.11 activation funnel (§9: W1 activation is THE single v1 metric).
 *
 * Funnel stages, in order: signup → auth completed → call created →
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
    { userId: "u1", stage: "auth_completed" },
    { userId: "u1", stage: "call_created" },
    { userId: "u1", stage: "first_line" },
    { userId: "u1", stage: "streamed_30s" },
    { userId: "u2", stage: "signup" },
    { userId: "u2", stage: "auth_completed" },
    { userId: "u2", stage: "call_created" },
    { userId: "u2", stage: "first_line" },
    { userId: "u2", stage: "streamed_30s" },
    // u3 — admitted, saw a line, but never reached 30 s (furthest = first_line).
    { userId: "u3", stage: "signup" },
    { userId: "u3", stage: "auth_completed" },
    { userId: "u3", stage: "call_created" },
    { userId: "u3", stage: "first_line" },
    // u4 — created a call, bot never produced a line (furthest = call_created).
    { userId: "u4", stage: "signup" },
    { userId: "u4", stage: "auth_completed" },
    { userId: "u4", stage: "call_created" },
    // u5 — clicked the magic link, never created a call.
    { userId: "u5", stage: "signup" },
    { userId: "u5", stage: "auth_completed" },
    // u6 — signed up only.
    { userId: "u6", stage: "signup" },
    // u7 — silent call: signup→magic→call→30 s of stream, NO first_line event.
    { userId: "u7", stage: "signup" },
    { userId: "u7", stage: "auth_completed" },
    { userId: "u7", stage: "call_created" },
    { userId: "u7", stage: "streamed_30s" },
  ];

  test("returns exact cumulative stage counts", () => {
    const snap = aggregateFunnel(fixture);
    expect(snap.stageCounts).toEqual({
      signup: 7,
      auth_completed: 6,
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
      { userId: "a", stage: "auth_completed" },
      { userId: "a", stage: "auth_completed" },
    ];
    const snap = aggregateFunnel(dups);
    expect(snap.total).toBe(1);
    expect(snap.stageCounts.auth_completed).toBe(1);
    expect(snap.activated).toBe(0);
  });
});

/**
 * S5-1 item 7 / issue #222 — stage 2 is `auth_completed`, NOT `magic_link_clicked`.
 *
 * The old name was derived from a consumed `magic_links` row, and the cumulative
 * back-fill then IMPUTED that stage to every Google user who got as far as
 * `call_created`. The discriminating fact is that the over-count is EXACTLY the
 * Google-only users who progressed: a Google signup who never creates a call has
 * `furthest = 0` and was already counted correctly. So a fix that simply added
 * one everywhere would be just as wrong, and both populations are asserted here.
 */
describe("auth_completed — S5-1 item 7 / #222", () => {
  test("stage 2 is auth_completed and the arity is still 5", () => {
    // Three stages after auth + the two before it: arity is unchanged at 5, so
    // every cumulative index/back-fill computation is untouched by the rename.
    const arity: number = FUNNEL_STAGES.length;
    expect(arity).toBe(3 + 2);
    expect(FUNNEL_STAGES[1]).toBe("auth_completed");
    expect([...FUNNEL_STAGES]).toEqual([
      "signup",
      "auth_completed",
      "call_created",
      "first_line",
      "streamed_30s",
    ]);
  });

  test("a user who created a call did complete auth (no magic link required)", () => {
    const snap = aggregateFunnel([
      { userId: "g1", stage: "signup", method: "google" },
      { userId: "g1", stage: "call_created", method: "google" },
    ]);
    expect(snap.stageCounts.auth_completed).toBe(1);
    expect(snap.stageCounts.signup).toBe(1);
    expect(snap.stageCounts.call_created).toBe(1);
  });

  test("a Google signup who never creates a call is NOT counted past signup", () => {
    const snap = aggregateFunnel([
      { userId: "g1", stage: "signup", method: "google" },
      { userId: "g1", stage: "call_created", method: "google" },
      // g2 signed up with Google and stopped. furthest = 0.
      { userId: "g2", stage: "signup", method: "google" },
    ]);
    expect(snap.stageCounts.signup).toBe(2);
    expect(snap.stageCounts.auth_completed).toBe(1);
    expect(snap.stageCounts.call_created).toBe(1);
  });

  test("splits every stage per signup method, and the split sums to the blend", () => {
    const snap = aggregateFunnel([
      { userId: "m1", stage: "signup", method: "magic_link" },
      { userId: "m1", stage: "auth_completed", method: "magic_link" },
      { userId: "m1", stage: "call_created", method: "magic_link" },
      { userId: "m2", stage: "signup", method: "magic_link" },
      { userId: "g1", stage: "signup", method: "google" },
      { userId: "g1", stage: "call_created", method: "google" },
      { userId: "g2", stage: "signup", method: "google" },
    ]);
    expect(snap.byMethod.magic_link.stageCounts).toEqual({
      signup: 2,
      auth_completed: 1,
      call_created: 1,
      first_line: 0,
      streamed_30s: 0,
    });
    expect(snap.byMethod.google.stageCounts).toEqual({
      signup: 2,
      auth_completed: 1,
      call_created: 1,
      first_line: 0,
      streamed_30s: 0,
    });
    expect(snap.stageCounts.signup).toBe(4);
    expect(snap.stageCounts.auth_completed).toBe(2);
  });

  test("per-method W1 fractions are exact and independent of the blend", () => {
    // §9 re-baselining case: 2 magic_link signups, 1 activated; 4 google, 1.
    const events: ActivationEvent[] = [
      { userId: "m1", stage: "signup", method: "magic_link" },
      { userId: "m1", stage: "streamed_30s", method: "magic_link" },
      { userId: "m2", stage: "signup", method: "magic_link" },
      { userId: "g1", stage: "signup", method: "google" },
      { userId: "g1", stage: "streamed_30s", method: "google" },
      { userId: "g2", stage: "signup", method: "google" },
      { userId: "g3", stage: "signup", method: "google" },
      { userId: "g4", stage: "signup", method: "google" },
    ];
    const snap = aggregateFunnel(events);
    expect(snap.byMethod.magic_link.w1Fraction).toBe(0.5);
    expect(snap.byMethod.google.w1Fraction).toBe(0.25);
    // The headline metric FALLS while the product improves (S5-1 item 7).
    expect(snap.w1Fraction).toBe(0.3333333333333333);
    expect(snap.byMethod.magic_link.total).toBe(2);
    expect(snap.byMethod.google.total).toBe(4);
    expect(snap.byMethod.google.activated).toBe(1);
  });

  test("an event with no method falls back to the documented default", () => {
    expect(DEFAULT_SIGNUP_METHOD).toBe("magic_link");
    const snap = aggregateFunnel([{ userId: "u", stage: "signup" }]);
    expect(snap.byMethod.magic_link.total).toBe(1);
    expect(snap.byMethod.google.total).toBe(0);
  });

  test("every method has a zeroed entry even with no events (no undefined series)", () => {
    const snap = aggregateFunnel([]);
    expect([...SIGNUP_METHODS]).toEqual(["magic_link", "google"]);
    for (const method of SIGNUP_METHODS) {
      expect(snap.byMethod[method].total).toBe(0);
      expect(snap.byMethod[method].w1Fraction).toBe(0);
      for (const stage of FUNNEL_STAGES) {
        expect(snap.byMethod[method].stageCounts[stage]).toBe(0);
      }
    }
  });

  test("a user's method is taken from the event stream consistently", () => {
    // The DB feed stamps the same `users.signup_method` on every row for a user;
    // if they ever disagreed, the FURTHEST-stage row must win, not row order.
    const snap = aggregateFunnel([
      { userId: "u", stage: "signup", method: "google" },
      { userId: "u", stage: "call_created", method: "google" },
    ]);
    expect(snap.byMethod.google.stageCounts.call_created).toBe(1);
    expect(snap.byMethod.magic_link.stageCounts.call_created).toBe(0);
  });
});
