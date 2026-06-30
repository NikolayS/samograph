/**
 * `GET /calls/:id/transcript?since_seq=N` REST gap-resync (SPEC §5.5, §5.6,
 * §5.10) — RED STUB (#83). Signatures only; the gate-authorized, RLS-scoped
 * read lands in the GREEN commit.
 */
import type { SQL } from "bun";
import type { AuthorizeDeps } from "../../packages/shared/auth/index.ts";
import type { TranscriptLine } from "./transcript.ts";

export interface TranscriptHandlerDeps {
  sql: SQL;
  authDeps: AuthorizeDeps;
  sessionCookieName?: string;
  backfillLimit?: number;
}

export interface TranscriptResponseBody {
  call_id: string;
  since_seq: number | null;
  lines: TranscriptLine[];
}

export function createTranscriptHandler(
  _deps: TranscriptHandlerDeps,
): (req: Request) => Promise<Response> {
  return async () => new Response(null, { status: 500 });
}
