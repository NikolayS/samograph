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
  method: "GET" | "POST";
  body: Record<string, unknown>;
}

export interface FailSpec {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface FakeAppApiClientOptions {
  /** When set, `verifyMagicLink` rejects with this typed error. */
  failVerifyWith?: FailSpec;
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
    const fail = this.options.failVerifyWith;
    if (fail) {
      throw new AppApiError(fail.code, fail.message, fail.retryable ?? false);
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
