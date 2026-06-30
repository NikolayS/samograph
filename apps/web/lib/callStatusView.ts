/**
 * Pure status-model view for the per-call page header (SPEC §5.2 lifecycle,
 * §5.16 error-code reference, Story 4). Maps a `CallStatus` to the exact
 * user-facing label/message + stable `SAMO-…` code and the UI affordances
 * (`isTerminal`, `showTryAgain`). DOM-free; typechecked by the root tsc.
 *
 * STUB: signatures only — behavioral bodies land in the GREEN commit.
 */
import type { CallStatus } from "./appApiClient.ts";
import { isTerminalStatus } from "./transcriptView.ts";

/** Visual treatment bucket for the status chip. */
export type StatusKind = "pending" | "joining" | "live" | "ended" | "error";

export interface StatusView {
  status: CallStatus;
  label: string;
  kind: StatusKind;
  message: string;
  /** Stable `SAMO-CALL-*` code (SPEC §5.16), only for terminal failures. */
  code?: string;
  isTerminal: boolean;
  /** Story 4: "Try again" → dashboard with URL pre-filled — only `COULD_NOT_JOIN`. */
  showTryAgain: boolean;
}

export interface StatusViewOptions {
  /** The underlying Recall reason surfaced for `COULD_NOT_JOIN` (§5.16). */
  recallReason?: string;
}

/** Default reason when Recall gives no specific `fatal` reason string. */
export const COULD_NOT_JOIN_FALLBACK_REASON = "the meeting couldn't be reached";

export function statusView(
  status: CallStatus,
  _opts: StatusViewOptions = {},
): StatusView {
  return {
    status,
    label: "STUB",
    kind: "pending",
    message: "STUB",
    isTerminal: isTerminalStatus(status),
    showTryAgain: false,
  };
}
