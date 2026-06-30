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
    void this.active;
    void this.counter;
    void shareUrlForToken;
  }

  async mintShare(_callId: string): Promise<ShareLink> {
    throw new AppApiError("SAMO-STUB", "not implemented", false);
  }

  async rotateShare(_callId: string): Promise<ShareLink> {
    throw new AppApiError("SAMO-STUB", "not implemented", false);
  }

  async revokeShare(_callId: string): Promise<void> {
    throw new AppApiError("SAMO-STUB", "not implemented", false);
  }

  async getShare(_callId: string): Promise<ShareLink | null> {
    throw new AppApiError("SAMO-STUB", "not implemented", false);
  }
}

export function createFakeShareApiClient(
  options?: FakeShareApiClientOptions,
): FakeShareApiClient {
  return new FakeShareApiClient(options);
}
