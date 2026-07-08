/**
 * Magic-link rate limiting (SPEC §5.1, §5.16 SAMO-AUTH-004, §6.2 #6).
 *
 * Two INDEPENDENT sliding-window counters — 5/hr per email AND 20/hr per IP —
 * whichever trips first blocks. They are independent so that, e.g., 20 requests
 * for 20 different emails from one IP trip the IP limit without any single email
 * reaching 5, and 6 requests for one email trip the email limit without the IP
 * (at 6) reaching 20. The limiter is an interface so a shared-state (Redis/PG)
 * impl can replace the in-memory one across replicas later.
 */

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimiter {
  /**
   * Non-committing check: would an attempt against `key` be within `limit` per
   * `windowMs` right now? Reads only — never advances the counter. Lets a caller
   * pre-check several INDEPENDENT limits and commit (`hit`) only if all pass, so
   * a rejection on one limit never perturbs another's counter (issue #63).
   */
  peek(key: string, limit: number, windowMs: number, now: number): Promise<boolean>;
  /** Record an attempt against `key` and report whether it is within `limit` per `windowMs`. */
  hit(key: string, limit: number, windowMs: number, now: number): Promise<RateDecision>;
}

/** In-memory sliding-window limiter (per-key timestamp list). */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  /** Read-only would-this-be-allowed check; does NOT mutate the counter. */
  async peek(
    key: string,
    limit: number,
    windowMs: number,
    now: number,
  ): Promise<boolean> {
    const cutoff = now - windowMs;
    const live = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);
    return live.length < limit;
  }

  async hit(
    key: string,
    limit: number,
    windowMs: number,
    now: number,
  ): Promise<RateDecision> {
    const cutoff = now - windowMs;
    // Keep only the timestamps still inside the sliding window.
    const live = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);

    if (live.length >= limit) {
      // Blocked. A blocked attempt does NOT consume a slot, so the counter is
      // never inflated past `limit`; the window frees up when the oldest expires.
      this.hits.set(key, live);
      const retryAfterMs = live[0] + windowMs - now;
      return { allowed: false, remaining: 0, retryAfterMs };
    }

    live.push(now);
    this.hits.set(key, live);
    return { allowed: true, remaining: limit - live.length, retryAfterMs: 0 };
  }
}
