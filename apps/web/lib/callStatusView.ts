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

/** Static label/kind/message for the non-failure statuses. */
const BASE: Record<
  Exclude<CallStatus, "COULD_NOT_JOIN" | "COULD_NOT_RECORD" | "BOT_REMOVED">,
  { label: string; kind: StatusKind; message: string }
> = {
  PENDING: { label: "Starting", kind: "pending", message: "Setting up samograph…" },
  JOINING: { label: "Joining", kind: "joining", message: "samograph is joining the call…" },
  IN_CALL: { label: "Live", kind: "live", message: "Live transcript is streaming." },
  ENDED: { label: "Ended", kind: "ended", message: "This call has ended." },
};

export function statusView(
  status: CallStatus,
  opts: StatusViewOptions = {},
): StatusView {
  const isTerminal = isTerminalStatus(status);

  if (status === "COULD_NOT_JOIN") {
    // §5.16: "Couldn't join — <Recall reason>." Strip any trailing period from
    // the reason so the template's own period is never doubled.
    const reason = (opts.recallReason ?? COULD_NOT_JOIN_FALLBACK_REASON)
      .trim()
      .replace(/\.+$/, "");
    return {
      status,
      label: "Couldn't join",
      kind: "error",
      message: `Couldn't join — ${reason}.`,
      code: "SAMO-CALL-JOIN",
      isTerminal,
      showTryAgain: true,
    };
  }

  if (status === "COULD_NOT_RECORD") {
    return {
      status,
      label: "Couldn't record",
      kind: "error",
      message: "Couldn't start recording — check meeting permissions.",
      code: "SAMO-CALL-NOREC",
      isTerminal,
      showTryAgain: false,
    };
  }

  if (status === "BOT_REMOVED") {
    return {
      status,
      label: "Bot removed",
      kind: "error",
      message: "The bot was removed from the call.",
      code: "SAMO-CALL-REMOVED",
      isTerminal,
      showTryAgain: false,
    };
  }

  const base = BASE[status];
  return {
    status,
    label: base.label,
    kind: base.kind,
    message: base.message,
    isTerminal,
    showTryAgain: false,
  };
}
