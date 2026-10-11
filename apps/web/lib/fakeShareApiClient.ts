/**
 * In-memory fake `ShareApiClient` for component/route tests. Records every
 * request so tests assert the exact call shape, mints deterministic tokens,
 * simulates rotate (new token supersedes old) and revoke (link gone), and can
 * be configured to throw typed `SAMO-…` failures — all with no token-service.
 *
 * Pure, DOM-free — typechecked by the repo-wide `tsc --noEmit`.
 *
 * STUB: signatures only — behavioral bodies land in the GREEN commit.
 */
import { AppApiError } from "./appApiClient.ts";
import {
  shareUrlForToken,
  type ShareApiClient,
  type ShareLink,
} from "./shareApiClient.ts";

export interface RecordedRequest {
  path: string;
  method: "GET" | "POST" | "DELETE";
}

export interface FailSpec {
  code: string;
  message: string;
  retryable?: boolean;
  status?: number;
}

export interface FakeShareApiClientOptions {
  /** When set, `mintShare` rejects with this typed error after recording. */
  failMintWith?: FailSpec;
  /** When set, `rotateShare` rejects with this typed error after recording. */
  failRotateWith?: FailSpec;
  /** When set, `revokeShare` rejects with this typed error after recording. */
  failRevokeWith?: FailSpec;
  /** When set, `getShare` rejects with this typed error after recording. */
  failGetWith?: FailSpec;
}

export class FakeShareApiClient implements ShareApiClient {
  readonly requests: RecordedRequest[] = [];
  private readonly active = new Map<string, ShareLink>();
  private counter = 0;
  private readonly options: FakeShareApiClientOptions;

  constructor(options: FakeShareApiClientOptions = {}) {
    this.options = options;
  }

  /** Mint the next deterministic token and make it the active share for `callId`. */
  private issue(callId: string): ShareLink {
    this.counter += 1;
    const token = `shr_${this.counter}`;
    const link: ShareLink = { token, url: shareUrlForToken(token), active: true };
    this.active.set(callId, link);
    return { ...link };
  }

  private static fail(spec: FailSpec): never {
    throw new AppApiError(spec.code, spec.message, spec.retryable ?? false, spec.status);
  }

  async mintShare(callId: string): Promise<ShareLink> {
    this.requests.push({ path: `/calls/${callId}/share`, method: "POST" });
    if (this.options.failMintWith) FakeShareApiClient.fail(this.options.failMintWith);
    return this.issue(callId);
  }

  async rotateShare(callId: string): Promise<ShareLink> {
    this.requests.push({ path: `/calls/${callId}/share/rotate`, method: "POST" });
    if (this.options.failRotateWith) FakeShareApiClient.fail(this.options.failRotateWith);
    // Rotation supersedes the old token: only the new one is active afterwards.
    return this.issue(callId);
  }

  async revokeShare(callId: string): Promise<void> {
    this.requests.push({ path: `/calls/${callId}/share`, method: "DELETE" });
    if (this.options.failRevokeWith) FakeShareApiClient.fail(this.options.failRevokeWith);
    this.active.delete(callId);
  }

  async getShare(callId: string): Promise<ShareLink | null> {
    this.requests.push({ path: `/calls/${callId}/share`, method: "GET" });
    if (this.options.failGetWith) FakeShareApiClient.fail(this.options.failGetWith);
    const link = this.active.get(callId);
    return link ? { ...link } : null;
  }
}

export function createFakeShareApiClient(
  options?: FakeShareApiClientOptions,
): FakeShareApiClient {
  return new FakeShareApiClient(options);
}
