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
  /** Record an attempt against `key` and report whether it is within `limit` per `windowMs`. */
  hit(key: string, limit: number, windowMs: number, now: number): Promise<RateDecision>;
}

/** In-memory sliding-window limiter (per-key timestamp ring). */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  async hit(
    _key: string,
    _limit: number,
    _windowMs: number,
    _now: number,
  ): Promise<RateDecision> {
    throw new Error("not implemented: InMemoryRateLimiter.hit");
  }
}
