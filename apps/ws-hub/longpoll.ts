/**
 * `GET /calls/:id/lines?since_seq=N&wait=S` — LONG-POLL transcript delivery for
 * the tunnel-free CLI (issue #307, prototype 2/3).
 *
 * The laptop asks "everything after cursor N" and the site answers:
 *   • at once, when lines with `seq > N` already exist (the exact tail, ascending,
 *     capped at {@link LONGPOLL_MAX_LINES} — the client simply asks again);
 *   • otherwise it HOLDS the request until a line for this call is committed or
 *     `wait` seconds pass (default 25, cap {@link LONGPOLL_MAX_WAIT_S} = 50 so a
 *     Cloudflare 100 s origin timeout / 524 can never fire), then answers `lines: []`.
 *
 * Correctness never depends on the wake-up:
 *   • the waiter is REGISTERED BEFORE the first query, so a line committed between
 *     "query saw nothing" and "start waiting" still wakes it (no lost-wakeup race);
 *   • a woken OR timed-out waiter always RE-RUNS the authorize + RLS-scoped read,
 *     so a wake is only a hint — the `since_seq` cursor over the gap-free per-call
 *     `seq` is the source of truth (exactly-once, in order, resumable);
 *   • each read is its own short transaction: a held request holds NO DB
 *     connection and NO transaction while it waits — just the HTTP request.
 *
 * Wake source: in the composed live stack (`liveBridge.ts`, prod today) the
 * fan-in calls {@link LineWaiters.notify} right after it publishes a committed
 * line onto the Hub — the same post-commit point the WS stream uses. Where no
 * wake source is wired (a standalone ws-hub), an optional per-waiter recheck tick
 * ({@link LongPollDeps.recheckMs}) re-reads periodically instead.
 *
 * Auth (stage 1): a per-call SHARE token, accepted ONLY from
 * `Authorization: Bearer …`. A `?token=` in the URL is refused with a bodyless
 * 400 (URLs end up in proxy/access logs). Every read passes `authorizeCall` +
 * RLS; DENY (bad/expired/revoked token, token for another call, unknown call) is
 * the single bodyless 403 — "exists" and "not found" are indistinguishable. This
 * module never logs.
 */
import type { SQL } from "bun";
import type { AuthorizeDeps } from "../../packages/shared/auth/index.ts";
import { authorizeCall } from "../../packages/shared/auth/index.ts";
import { parseSinceSeq } from "./request.ts";
import { RequestRateCaps, rateLimitedResponse, shareCapKey } from "./caps.ts";
import { replayTranscripts, type TranscriptLine } from "./transcript.ts";

/** Default hold when the client omits `wait` (seconds). */
export const LONGPOLL_DEFAULT_WAIT_S = 25;
/** Hard cap on `wait` (seconds): well under Cloudflare's 100 s origin timeout. */
export const LONGPOLL_MAX_WAIT_S = 50;
/** Max lines per response; a larger backlog is drained by the next request. */
export const LONGPOLL_MAX_LINES = 500;
/**
 * Per-token request budget for `/lines` per 60 s window. Deliberately separate
 * from (and larger than) the 120/min `/transcript` cap: a long-poll response is
 * cursor-bounded (≤ {@link LONGPOLL_MAX_LINES}), and a fast-talking burst turns
 * into one request per returned batch. Still finite, so a leaked link cannot
 * drive unbounded reads.
 */
export const LONGPOLL_REQUESTS_PER_WINDOW = 600;
/** Max concurrently held requests per call (bounds memory for a leaked link). */
export const LONGPOLL_MAX_WAITERS_PER_CALL = 64;

/** One registered, one-shot wake-up for a call. */
export interface LineWaiter {
  /** Resolves when {@link LineWaiters.notify} fires for the call. Never rejects. */
  promise: Promise<void>;
  /** Deregister (idempotent; safe after a notify). */
  cancel(): void;
}

/**
 * In-process per-call wake-up registry. Holds only closures — no DB handles.
 * `notify(callId)` resolves (and removes) every waiter registered for the call.
 */
export class LineWaiters {
  private readonly byCall = new Map<string, Set<() => void>>();

  register(callId: string): LineWaiter {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    let set = this.byCall.get(callId);
    if (!set) {
      set = new Set();
      this.byCall.set(callId, set);
    }
    const entry = () => resolve();
    set.add(entry);
    return {
      promise,
      cancel: () => {
        const s = this.byCall.get(callId);
        if (!s) return;
        s.delete(entry);
        if (s.size === 0) this.byCall.delete(callId);
      },
    };
  }

  notify(callId: string): void {
    const set = this.byCall.get(callId);
    if (!set) return;
    this.byCall.delete(callId);
    for (const wake of set) wake();
  }

  /** Registered waiters for one call, or across all calls (observability/tests). */
  size(callId?: string): number {
    if (callId !== undefined) return this.byCall.get(callId)?.size ?? 0;
    let n = 0;
    for (const s of this.byCall.values()) n += s.size;
    return n;
  }
}

/** Injected collaborators for {@link createLongPollHandler}. */
export interface LongPollDeps {
  /** Privileged connection able to `SET LOCAL ROLE samograph_app`. */
  sql: SQL;
  /** Tenancy-gate seams (keyring + call→tenant lookup). */
  authDeps: AuthorizeDeps;
  /** Wake-up registry the fan-in notifies after each committed line. */
  waiters: LineWaiters;
  /** Per-token request-rate cap (charged once per HTTP request, not per re-read). */
  restCaps?: RequestRateCaps;
  clockMs?: () => number;
  /**
   * Re-read every `recheckMs` while held even without a wake (fallback for a
   * deployment with no in-process wake source). 0/undefined ⇒ wake + deadline only.
   */
  recheckMs?: number;
  /** Max lines per response; defaults to {@link LONGPOLL_MAX_LINES}. */
  maxLines?: number;
  /** After a wake, pause this long before re-reading so a burst is batched. */
  coalesceMs?: number;
  /** Max held requests per call; defaults to {@link LONGPOLL_MAX_WAITERS_PER_CALL}. */
  maxWaitersPerCall?: number;
}

/** Shape of a successful long-poll response. */
export interface LongPollResponseBody {
  call_id: string;
  /** Echo of the request cursor. */
  since_seq: number;
  /** The cursor to send next: the last returned `seq`, or `since_seq` if none. */
  next_seq: number;
  lines: TranscriptLine[];
}

type ReadOutcome =
  | { kind: "denied" }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "ok"; lines: TranscriptLine[] };

export const LINES_PATH = /^\/calls\/([^/]+)\/lines$/;
const BEARER = /^Bearer\s+(\S+)\s*$/i;

/** Parse `?wait` seconds: absent/invalid → default; clamped to [0, 50]. */
export function parseWaitSeconds(url: URL): number {
  const raw = url.searchParams.get("wait")?.trim();
  if (!raw || !/^\d+$/.test(raw)) return LONGPOLL_DEFAULT_WAIT_S;
  return Math.min(Number(raw), LONGPOLL_MAX_WAIT_S);
}

/** The bearer credential, from the `Authorization` header ONLY. */
function readBearer(req: Request): string | null {
  const m = (req.headers.get("authorization") ?? "").match(BEARER);
  return m ? m[1] : null;
}

/** Wait for a wake, a timeout, or a client abort. True iff woken. */
function waitForWake(wake: Promise<void>, ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (woken: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(woken);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
    void wake.then(() => finish(true));
  });
}

const empty = (status: number) => new Response(null, { status });

/** Build the `GET /calls/:id/lines` long-poll handler (404 for other paths). */
export function createLongPollHandler(deps: LongPollDeps): (req: Request) => Promise<Response> {
  const maxLines = deps.maxLines ?? LONGPOLL_MAX_LINES;
  const maxWaiters = deps.maxWaitersPerCall ?? LONGPOLL_MAX_WAITERS_PER_CALL;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const match = url.pathname.match(LINES_PATH);
    if (!match) return empty(404);
    if (req.method !== "GET") return empty(405);
    // Secrets never ride in URLs: refuse, don't read, a `?token=`.
    if (url.searchParams.has("token")) return empty(400);
    const sinceSeq = parseSinceSeq(url);
    if (sinceSeq === null) return empty(400); // the cursor is mandatory — never a fixed tail
    const waitMs = parseWaitSeconds(url) * 1000;
    const token = readBearer(req);
    if (!token) return empty(403);
    let callId: string;
    try {
      callId = decodeURIComponent(match[1]);
    } catch {
      return empty(403);
    }

    /** Authorize + RLS-scoped read in ONE short tx (released before any wait). */
    const read = (charge: boolean): Promise<ReadOutcome> =>
      deps.sql.begin(async (tx): Promise<ReadOutcome> => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        const authz = await authorizeCall(tx as unknown as SQL, { callId, shareToken: token }, deps.authDeps);
        if (!authz.authorized) return { kind: "denied" };
        if (charge && deps.restCaps) {
          const rate = deps.restCaps.tryRequest(shareCapKey(token), (deps.clockMs ?? Date.now)());
          if (!rate.allowed) return { kind: "rate_limited", retryAfterMs: rate.retryAfterMs };
        }
        return { kind: "ok", lines: await replayTranscripts(tx as unknown as SQL, callId, sinceSeq, maxLines) };
      });

    const deadline = performance.now() + waitMs;
    // Register BEFORE the first read: a commit landing between the read and the
    // wait still resolves this waiter (no lost wake-up).
    let waiter = deps.waiters.register(callId);
    try {
      let outcome = await read(true);
      if (outcome.kind === "ok" && outcome.lines.length === 0 && waitMs > 0) {
        if (deps.waiters.size(callId) > maxWaiters) return rateLimitedResponse(1000);
      }
      while (outcome.kind === "ok" && outcome.lines.length === 0) {
        const remaining = deadline - performance.now();
        if (remaining <= 0 || req.signal.aborted) break;
        const slice = deps.recheckMs ? Math.min(remaining, deps.recheckMs) : remaining;
        const woken = await waitForWake(waiter.promise, slice, req.signal);
        if (req.signal.aborted) break; // client gone — nobody to answer
        if (woken && deps.coalesceMs) await new Promise((r) => setTimeout(r, deps.coalesceMs));
        // Re-arm BEFORE re-reading, then always re-run the authorized read.
        waiter.cancel();
        waiter = deps.waiters.register(callId);
        outcome = await read(false);
      }
      if (outcome.kind === "denied") return empty(403);
      if (outcome.kind === "rate_limited") return rateLimitedResponse(outcome.retryAfterMs);
      const lines = outcome.lines;
      const body: LongPollResponseBody = {
        call_id: callId,
        since_seq: sinceSeq,
        next_seq: lines.length ? lines[lines.length - 1].seq : sinceSeq,
        lines,
      };
      return Response.json(body, { status: 200, headers: { "cache-control": "no-store" } });
    } finally {
      waiter.cancel();
    }
  };
}
