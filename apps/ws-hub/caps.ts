/**
 * Share-scope anti-abuse caps for the ws-hub (SPEC §5.7, §6.2 #10, §5.16).
 *
 * The `share` scope is an anonymous, owner-minted link, so it carries explicit
 * numeric caps that the `read` (session-derived) scope does not. This module is
 * the pure, transport-agnostic limiter; the stream layer (./stream.ts) consults
 * it for `share`-tagged connections only and leaves `read` connections untouched.
 *
 * Three caps, every one keyed strictly per token / per connection so one link (or
 * one connection) hitting a cap never affects another:
 *   • per-token CONCURRENT connections   = 200   (201st  → 429; closing frees one)
 *   • per-connection COMMAND rate         = 20 / 60 s (21st  → 429; window slides)
 *   • per-token ESTABLISHMENT rate        = 1000 / hour (1001st → 429; anti-fuzz)
 *
 * Over any cap → `SAMO-RATE-001` (429, retryable, honor `Retry-After`; §5.16). A
 * DENIED attempt never consumes a slot or records a timestamp, so a counter is
 * never inflated past its cap (same discipline as the magic-link rate limiter).
 *
 * The cap key for a token is a sha256 of the share-token string (its stable
 * identity) — never the raw secret as a map key, never logged.
 */
import { createHash } from "node:crypto";

// ── Spec numbers (§5.7). Defaults of {@link ShareCaps}; overridable for tests. ──
/** Per-token concurrent-connection cap. */
export const SHARE_MAX_CONCURRENT = 200;
/** Per-connection client→server command budget per {@link SHARE_COMMAND_WINDOW_MS}. */
export const SHARE_COMMANDS_PER_WINDOW = 20;
/** Command-rate sliding window: 60 seconds. */
export const SHARE_COMMAND_WINDOW_MS = 60_000;
/** Per-token connection-establishment budget per {@link SHARE_ESTABLISH_WINDOW_MS}. */
export const SHARE_ESTABLISH_PER_WINDOW = 1000;
/** Establishment-rate sliding window: 1 hour. */
export const SHARE_ESTABLISH_WINDOW_MS = 60 * 60 * 1000;

/** Stable error code for a share cap breach (§5.16: 429, retryable). */
export const RATE_LIMIT_ERROR_CODE = "SAMO-RATE-001" as const;

/**
 * Retry-After hint for the CONCURRENT cap, which has no time window — a slot frees
 * when a peer connection closes, and open sockets are re-authorized every ≤ 1 s
 * (the revoke recheck, §5.5), so a one-second back-off is the right granularity.
 */
const CONCURRENT_RETRY_AFTER_MS = 1_000;

/** Knobs for {@link ShareCaps}; omitted fields fall back to the spec defaults. */
export interface ShareCapsConfig {
  maxConcurrent: number;
  commandsPerWindow: number;
  commandWindowMs: number;
  establishPerWindow: number;
  establishWindowMs: number;
}

/** A limiter decision: admitted, or denied with a positive back-off hint. */
export interface CapDecision {
  allowed: boolean;
  /** Milliseconds to wait before retrying (0 when allowed). */
  retryAfterMs: number;
}

const ALLOWED: CapDecision = Object.freeze({ allowed: true, retryAfterMs: 0 });

/**
 * In-memory share-scope limiter. One instance per ws-hub process; per-token and
 * per-connection state lives in maps keyed by the caller-supplied keys.
 *
 * (In-process is correct for v1's single-region hub; a shared-state impl behind
 * this same surface can replace it across replicas later, exactly like the
 * magic-link {@link InMemoryRateLimiter}.)
 */
export class ShareCaps {
  private readonly cfg: ShareCapsConfig;
  /** tokenKey → number of currently-open connections. */
  private readonly concurrentByToken = new Map<string, number>();
  /** tokenKey → establishment timestamps still inside the establishment window. */
  private readonly establishByToken = new Map<string, number[]>();
  /** connectionKey → command timestamps still inside the command window. */
  private readonly commandsByConn = new Map<string, number[]>();

  constructor(config: Partial<ShareCapsConfig> = {}) {
    this.cfg = {
      maxConcurrent: config.maxConcurrent ?? SHARE_MAX_CONCURRENT,
      commandsPerWindow: config.commandsPerWindow ?? SHARE_COMMANDS_PER_WINDOW,
      commandWindowMs: config.commandWindowMs ?? SHARE_COMMAND_WINDOW_MS,
      establishPerWindow: config.establishPerWindow ?? SHARE_ESTABLISH_PER_WINDOW,
      establishWindowMs: config.establishWindowMs ?? SHARE_ESTABLISH_WINDOW_MS,
    };
  }

  /** Currently-open connection count for a token (observability / tests). */
  concurrent(tokenKey: string): number {
    return this.concurrentByToken.get(tokenKey) ?? 0;
  }

  /**
   * Admit a new share connection for `tokenKey`, or deny it. Checks the
   * establishment-rate cap (anti-fuzz) first, then the concurrent cap. On ADMIT
   * it records one establishment timestamp AND increments the concurrent count —
   * callers MUST pair a successful establish with exactly one {@link release}
   * (the stream connection releases on close). A DENY mutates nothing.
   */
  tryEstablish(tokenKey: string, now: number): CapDecision {
    // 1) Establishment rate (1000 / hour) — the anti-fuzz cap.
    const cutoff = now - this.cfg.establishWindowMs;
    const live = (this.establishByToken.get(tokenKey) ?? []).filter((ts) => ts > cutoff);
    if (live.length >= this.cfg.establishPerWindow) {
      this.establishByToken.set(tokenKey, live); // prune; do not consume a slot
      return { allowed: false, retryAfterMs: live[0] + this.cfg.establishWindowMs - now };
    }

    // 2) Concurrent connections (200) — frees when a peer connection closes.
    const open = this.concurrentByToken.get(tokenKey) ?? 0;
    if (open >= this.cfg.maxConcurrent) {
      this.establishByToken.set(tokenKey, live); // keep the pruned window; no record
      return { allowed: false, retryAfterMs: CONCURRENT_RETRY_AFTER_MS };
    }

    // Admit: record the establishment and reserve the concurrent slot.
    live.push(now);
    this.establishByToken.set(tokenKey, live);
    this.concurrentByToken.set(tokenKey, open + 1);
    return ALLOWED;
  }

  /** Release one concurrent slot for `tokenKey` (idempotent at zero). */
  release(tokenKey: string): void {
    const open = this.concurrentByToken.get(tokenKey) ?? 0;
    if (open <= 1) this.concurrentByToken.delete(tokenKey);
    else this.concurrentByToken.set(tokenKey, open - 1);
  }

  /**
   * Drop a connection's command-rate state (#102 review note). The per-connection
   * sliding window in {@link commandsByConn} is otherwise never reclaimed, so a
   * long-lived hub would leak one array per connection ever opened. The stream
   * connection calls this on close, keyed on its connection id.
   */
  forgetConnection(connectionKey: string): void {
    this.commandsByConn.delete(connectionKey);
  }

  /** Whether any command-rate state is retained for a connection (observability / tests). */
  tracksConnection(connectionKey: string): boolean {
    return this.commandsByConn.has(connectionKey);
  }

  /**
   * Admit a client→server command on `connectionKey`, or deny it (20 / 60 s,
   * sliding). A DENY does not consume a slot, so the window frees as the oldest
   * command ages out.
   */
  tryCommand(connectionKey: string, now: number): CapDecision {
    const cutoff = now - this.cfg.commandWindowMs;
    const live = (this.commandsByConn.get(connectionKey) ?? []).filter((ts) => ts > cutoff);
    if (live.length >= this.cfg.commandsPerWindow) {
      this.commandsByConn.set(connectionKey, live);
      return { allowed: false, retryAfterMs: live[0] + this.cfg.commandWindowMs - now };
    }
    live.push(now);
    this.commandsByConn.set(connectionKey, live);
    return ALLOWED;
  }
}

/** Stable per-token cap key: sha256 of the share-token string (never the raw secret). */
export function shareCapKey(shareToken: string): string {
  return createHash("sha256").update(shareToken).digest("hex");
}

/**
 * Render the `SAMO-RATE-001` 429 a cap breach returns (§5.16). `Retry-After` is
 * the back-off in WHOLE seconds, at least 1 (a sub-second hint still asks for a
 * one-second wait), so clients always honor a real delay.
 */
export function rateLimitedResponse(retryAfterMs: number): Response {
  const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new Response(
    JSON.stringify({
      code: RATE_LIMIT_ERROR_CODE,
      message: "Too many connections or commands on this link.",
      retryable: true,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "Retry-After": String(retryAfterSec),
      },
    },
  );
}
