/**
 * In-memory fake `AppApiClient` for component/route tests. Records every request
 * so tests can assert the exact call shape, and returns deterministic responses
 * with no network. Configure `failVerifyWith` to exercise the typed
 * `SAMO-AUTH-00x` error paths on the callback page.
 *
 * Pure, DOM-free — typechecked by the repo-wide `tsc --noEmit`.
 */
import {
  AppApiError,
  type AppApiClient,
  type Call,
  type CreateCallInput,
  type RequestMagicLinkInput,
} from "./appApiClient.ts";
import { validateMeetingUrl } from "./validateMeetingUrl.ts";

export interface RecordedRequest {
  path: string;
  method: "GET" | "POST" | "DELETE";
  body: Record<string, unknown>;
}

export interface FailSpec {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface FakeAppApiClientOptions {
  /**
   * When set, `verifyMagicLink` rejects with this typed error. Include `status`
   * to simulate an infra/5xx response (whose body may lack a `code`).
   */
  failVerifyWith?: FailSpec & { status?: number };
  /**
   * When set, `verifyMagicLink` rejects with this raw (non-typed) error AFTER
   * recording the request — simulates a network failure (fetch throws before
   * any HTTP status is known).
   */
  failVerifyWithRaw?: Error;
  /**
   * When true, `verifyMagicLink` records its request but never settles, so a
   * test can deterministically observe the "verifying" state with no race.
   */
  holdVerify?: boolean;
  /** Seed `listCalls` with pre-existing tenant calls (e.g. to test reload). */
  seedCalls?: Call[];
  /** DEV-link returned by `lastDevMagicLink` (simulates the `__dev` endpoint). */
  devMagicLink?: string;
  /**
   * When set, `createCall` rejects with this typed error AFTER recording the
   * request — simulates a server-side rejection (e.g. SAMO-CALL-URL) for a URL
   * that passes the client's looser pre-flight check.
   */
  failCreateCallWith?: FailSpec & { status?: number };
  /**
   * When set, the next `listCalls` rejects with this typed error (e.g. a 401 to
   * exercise the dashboard's auth-gate redirect).
   */
  failListCallsWith?: FailSpec & { status?: number };
  /**
   * When set, `logout` rejects with this typed error AFTER recording the request
   * — lets a test assert the button STILL redirects on a best-effort failure.
   */
  failLogoutWith?: FailSpec & { status?: number };
  /**
   * When set, `deleteCall` rejects with this typed error AFTER recording the
   * request — simulates a server-side rejection (e.g. a 404/403) so a test can
   * assert the per-call delete's error path.
   */
  failDeleteCallWith?: FailSpec & { status?: number };
  /**
   * When set, `deleteAccount` rejects with this typed error AFTER recording the
   * request — simulates a server-side rejection (e.g. a 403/401) so a test can
   * assert the danger-zone error path (no redirect, error surfaced).
   */
  failDeleteAccountWith?: FailSpec & { status?: number };
}

export class FakeAppApiClient implements AppApiClient {
  readonly requests: RecordedRequest[] = [];
  private callCounter = 0;
  private readonly calls: Call[] = [];
  private readonly options: FakeAppApiClientOptions;

  constructor(options: FakeAppApiClientOptions = {}) {
    this.options = options;
    if (options.seedCalls) this.calls.push(...options.seedCalls);
  }

  async requestMagicLink(input: RequestMagicLinkInput): Promise<void> {
    this.requests.push({
      path: "/auth/magic-link",
      method: "POST",
      body: { email: input.email },
    });
  }

  async verifyMagicLink(token: string): Promise<void> {
    this.requests.push({
      path: "/auth/callback",
      method: "GET",
      body: { token },
    });
    if (this.options.holdVerify) {
      // Never settle: lets a test observe the "verifying" state with no race.
      return new Promise<void>(() => {});
    }
    if (this.options.failVerifyWithRaw) {
      throw this.options.failVerifyWithRaw;
    }
    const fail = this.options.failVerifyWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false, fail.status);
    }
  }

  async logout(): Promise<void> {
    this.requests.push({ path: "/auth/logout", method: "POST", body: {} });
    const fail = this.options.failLogoutWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false, fail.status);
    }
  }

  async createCall(input: CreateCallInput): Promise<Call> {
    // Record the SERVER's body contract (snake_case `meeting_url`, SPEC §5.2) —
    // the same key the real `createHttpAppApiClient` serializes — so component
    // tests assert against the wire shape, not a client-only camelCase shape.
    this.requests.push({
      path: "/calls",
      method: "POST",
      body: { meeting_url: input.meetingUrl },
    });
    const fail = this.options.failCreateCallWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false, fail.status);
    }
    const validation = validateMeetingUrl(input.meetingUrl);
    if (!validation.ok) {
      // Mirror app-api's typed rejection verbatim (code + copy, calls/errors.ts).
      throw new AppApiError(
        "SAMO-CALL-URL",
        "That doesn't look like a Zoom or Google Meet meeting link.",
        false,
        400,
      );
    }
    this.callCounter += 1;
    const call: Call = {
      id: `call_${this.callCounter}`,
      meetingUrl: validation.url,
      provider: validation.provider,
      status: "PENDING",
    };
    this.calls.unshift(call);
    return call;
  }

  async deleteCall(callId: string): Promise<void> {
    this.requests.push({
      path: `/calls/${callId}`,
      method: "DELETE",
      body: {},
    });
    const fail = this.options.failDeleteCallWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false, fail.status);
    }
    // Success: drop the call from the in-memory list so a subsequent listCalls
    // reflects the erasure (§5.14), mirroring the server's row delete.
    const idx = this.calls.findIndex((c) => c.id === callId);
    if (idx !== -1) this.calls.splice(idx, 1);
  }

  async deleteAccount(): Promise<void> {
    this.requests.push({ path: "/account", method: "DELETE", body: {} });
    const fail = this.options.failDeleteAccountWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false, fail.status);
    }
    // Success: the whole account is gone — drop the in-memory call list too.
    this.calls.length = 0;
  }

  async listCalls(): Promise<Call[]> {
    this.requests.push({ path: "/calls", method: "GET", body: {} });
    const fail = this.options.failListCallsWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false, fail.status);
    }
    return this.calls.map((c) => ({ ...c }));
  }

  async lastDevMagicLink(email: string): Promise<string | null> {
    this.requests.push({
      path: "/__dev/last-magic-link",
      method: "GET",
      body: { email },
    });
    return this.options.devMagicLink ?? null;
  }
}

export function createFakeAppApiClient(
  options?: FakeAppApiClientOptions,
): FakeAppApiClient {
  return new FakeAppApiClient(options);
}
