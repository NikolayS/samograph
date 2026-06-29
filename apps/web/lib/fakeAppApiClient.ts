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
}

export class FakeAppApiClient implements AppApiClient {
  readonly requests: RecordedRequest[] = [];
  private callCounter = 0;
  private readonly options: FakeAppApiClientOptions;

  constructor(options: FakeAppApiClientOptions = {}) {
    this.options = options;
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

  async createCall(input: CreateCallInput): Promise<Call> {
    this.requests.push({
      path: "/calls",
      method: "POST",
      body: { meetingUrl: input.meetingUrl },
    });
    const validation = validateMeetingUrl(input.meetingUrl);
    if (!validation.ok) {
      throw new AppApiError(
        "SAMO-CALL-JOIN",
        "Couldn't join — that doesn't look like a Zoom or Google Meet link.",
        false,
      );
    }
    this.callCounter += 1;
    return {
      id: `call_${this.callCounter}`,
      meetingUrl: validation.url,
      provider: validation.provider,
      status: "PENDING",
    };
  }
}

export function createFakeAppApiClient(
  options?: FakeAppApiClientOptions,
): FakeAppApiClient {
  return new FakeAppApiClient(options);
}
