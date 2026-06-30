/**
 * App-api worker discovery + invocation seam (SPEC §5.8, §6.2 #9, §5.16) — no DB.
 *
 * `resolveWorker(call_id)` (RLS-filtered) is the same code path v1 app-api and v2
 * agent-gateway use to reach the per-call bot-worker. These no-DB tests pin the
 * two non-DB contracts:
 *   • #2 — a dead/stale worker surfaces as a clean 503 (`SAMO-WORKER-503`), NOT a
 *     hang: the inter-service call is bounded (AbortSignal.timeout) and a refused
 *     connection or a never-answering worker both resolve to a fast 503.
 *   • #4 — the tenancy gate (`authorizeCall`) runs BEFORE the inter-service auth,
 *     so a denied caller never resolves or calls the worker at all (even with a
 *     leaked worker secret in hand).
 * The RLS-resolve + real-loopback integration lives in the DB-gated suite.
 */
import { describe, it, expect } from "bun:test";
import {
  callWorker,
  invokeWorker,
  WORKER_UNAVAILABLE,
  type ResolvedWorker,
  type FetchFn,
} from "./discovery.ts";
import type { AuthorizeResult } from "../../../packages/shared/auth/index.ts";

const WORKER: ResolvedWorker = { callId: "c1", host: "127.0.0.1", port: 59999 };
const SECRET = "app-api-knows-this-worker-secret";
const CALL = { method: "POST", verb: "chat", body: { message: "hi" } } as const;

describe("callWorker — bounded inter-service call → clean 503 (§6.2 #9.2, §5.16)", () => {
  it("forwards with Authorization: Bearer <secret> and passes a 2xx through", async () => {
    const captured: { auth: string | null; url: string } = { auth: null, url: "" };
    const fetchFn: FetchFn = async (url, init) => {
      captured.url = String(url);
      captured.auth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const res = await callWorker(WORKER, SECRET, CALL, { fetch: fetchFn });
    expect(res.status).toBe(200);
    expect(captured.auth).toBe(`Bearer ${SECRET}`);
    expect(captured.url).toBe(`http://127.0.0.1:59999/v1/call/c1/chat`);
  });

  it("a refused/dead worker (fetch throws) → 503 SAMO-WORKER-503, retryable", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const res = await callWorker(WORKER, SECRET, CALL, { fetch: fetchFn });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; retryable: boolean };
    expect(body.code).toBe(WORKER_UNAVAILABLE);
    expect(body.retryable).toBe(true);
  });

  it("a never-answering worker is bounded by the timeout → fast 503, NOT a hang", async () => {
    // Simulate a stale row whose process accepts but never responds: the promise
    // only settles when the AbortSignal fires. With a tiny timeout the call must
    // resolve to 503 quickly (well under a wall-clock hang).
    const hangingFetch: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }
      });

    const started = Date.now();
    const res = await callWorker(WORKER, SECRET, CALL, { fetch: hangingFetch, timeoutMs: 50 });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe(WORKER_UNAVAILABLE);
    expect(elapsed).toBeGreaterThanOrEqual(40); // the bound actually fired
    expect(elapsed).toBeLessThan(2000); // …and it did NOT hang
  });
});

describe("invokeWorker — tenancy gate runs BEFORE inter-service auth (§6.2 #9.4)", () => {
  const fakeTx = {} as never; // gate/resolve are injected; the tx is never touched here.

  function spies(authz: AuthorizeResult) {
    const calls = { resolved: 0, called: 0 };
    const deps = {
      gate: {} as never,
      authorize: async () => authz,
      resolve: async (): Promise<ResolvedWorker | null> => {
        calls.resolved += 1;
        return WORKER;
      },
      workerSecret: () => SECRET,
      call: async (): Promise<Response> => {
        calls.called += 1;
        return new Response(null, { status: 200 });
      },
    };
    return { calls, deps };
  }

  const DENY: AuthorizeResult = { authorized: false, status: 403, code: "SAMO-AUTHZ-001" };
  const GRANT: AuthorizeResult = {
    authorized: true,
    tenantId: "t1",
    callId: "c1",
    scopes: ["read"],
  };

  it("gate DENY → 403 and the worker is NEVER resolved or called (even with a leaked secret)", async () => {
    const { calls, deps } = spies(DENY);
    const res = await invokeWorker(fakeTx, { callId: "c1", sessionCookie: "leaked" }, CALL, deps);
    expect(res.status).toBe(403);
    expect(calls.resolved).toBe(0); // gate-first: short-circuits before discovery
    expect(calls.called).toBe(0);
  });

  it("gate GRANT → resolves then calls the worker, passing the 2xx through", async () => {
    const { calls, deps } = spies(GRANT);
    const res = await invokeWorker(fakeTx, { callId: "c1", sessionCookie: "ok" }, CALL, deps);
    expect(res.status).toBe(200);
    expect(calls.resolved).toBe(1);
    expect(calls.called).toBe(1);
  });

  it("gate GRANT but no registered worker row → 503 SAMO-WORKER-503 (not a hang)", async () => {
    const { deps } = spies(GRANT);
    deps.resolve = async () => null; // discovery finds no live worker
    const res = await invokeWorker(fakeTx, { callId: "c1", sessionCookie: "ok" }, CALL, deps);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe(WORKER_UNAVAILABLE);
  });
});
