/**
 * `GET /calls/:id/stream` WS upgrade core (SPEC §5.5, §5.6, §6.2 #3/#4) —
 * RED STUB (#83). Type surface only; the real authorize-no-cache + backfill-
 * then-live + `?since_seq` replay + revoke recheck land in the GREEN commit.
 */
import type { SQL } from "bun";
import type { AuthorizeDeps } from "../../packages/shared/auth/index.ts";
import { Hub } from "./hub.ts";
import type { CallCredentials } from "./request.ts";
import type { TranscriptLine } from "./transcript.ts";

export const RECHECK_INTERVAL_MS = 1000;

export type StreamScope = "read" | "share";

export interface StreamSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type StreamCredentials = CallCredentials;

export interface ParsedStreamRequest {
  callId: string;
  sinceSeq: number | null;
  credentials: StreamCredentials;
}

export interface StreamAuthDeps extends AuthorizeDeps {
  sessionCookieName?: string;
}

export type PrepareStreamResult =
  | {
      ok: true;
      callId: string;
      tenantId: string;
      scope: StreamScope;
      scopes: string[];
      sinceSeq: number | null;
      credentials: StreamCredentials;
    }
  | { ok: false; response: Response };

export interface StreamConnectionInit {
  socket: StreamSocket;
  hub: Hub;
  callId: string;
  scope: StreamScope;
  subscriber: ReturnType<Hub["subscribe"]>;
  initialSeq: number;
  reauthorize: () => Promise<boolean>;
}

export interface OpenStreamDeps {
  sql: SQL;
  hub: Hub;
  authDeps: AuthorizeDeps;
  backfillLimit?: number;
}

// ── RED stubs — wrong/placeholder behavior so the specs fail (#83) ───────────

export function parseStreamRequest(_req: Request, _cookieName?: string): ParsedStreamRequest | null {
  return null;
}

export async function prepareStream(
  _sql: SQL,
  _req: Request,
  _deps: StreamAuthDeps,
): Promise<PrepareStreamResult> {
  return {
    ok: true,
    callId: "",
    tenantId: "",
    scope: "read",
    scopes: [],
    sinceSeq: null,
    credentials: { sessionCookie: null, shareToken: null },
  };
}

export class StreamConnection {
  readonly callId: string;
  readonly scope: StreamScope;
  constructor(init: StreamConnectionInit) {
    this.callId = init.callId;
    this.scope = init.scope;
  }
  highWaterSeq(): number {
    return 0;
  }
  isClosed(): boolean {
    return false;
  }
  sendBackfill(_lines: TranscriptLine[]): void {}
  flush(): void {}
  async recheck(): Promise<boolean> {
    return true;
  }
  close(_code?: number, _reason?: string): void {}
}

export async function openStream(
  _socket: StreamSocket,
  _prepared: Extract<PrepareStreamResult, { ok: true }>,
  _deps: OpenStreamDeps,
): Promise<StreamConnection> {
  throw new Error("RED: openStream not implemented (#83)");
}
