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
  /**
   * Bespoke, human-readable guidance for a terminal failure the user can act on
   * (`COULD_NOT_RECORD`, `BOT_REMOVED`). Rendered under the §5.16 message so the
   * failure never reads as a dead end. `COULD_NOT_JOIN` deliberately has none —
   * its recovery is the Story-4 "Try again" affordance, not a hint.
   */
  hint?: string;
  isTerminal: boolean;
  /** Story 4: "Try again" → dashboard with URL pre-filled — only `COULD_NOT_JOIN`. */
  showTryAgain: boolean;
}

export interface StatusViewOptions {
  /**
   * The underlying failure reason (the server's `calls.status_reason`, e.g.
   * Recall's `sub_code`) surfaced in the terminal-failure message for
   * `COULD_NOT_JOIN` and `COULD_NOT_RECORD` (§5.16).
   */
  recallReason?: string;
}

/** Default reason when Recall gives no specific `fatal` reason string. */
export const COULD_NOT_JOIN_FALLBACK_REASON = "the meeting couldn't be reached";

/** Default reason when no specific `COULD_NOT_RECORD` reason was recorded (§5.16). */
export const COULD_NOT_RECORD_FALLBACK_REASON = "check meeting permissions";

/** Normalize a §5.16 reason for the "… — <reason>." template (no doubled period). */
function templateReason(reason: string): string {
  return reason.trim().replace(/\.+$/, "");
}

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
    // §5.16: "Couldn't join — <Recall reason>."
    const reason = templateReason(opts.recallReason ?? COULD_NOT_JOIN_FALLBACK_REASON);
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
    // §5.16: "Couldn't start recording — <reason>." (fallback: "check meeting
    // permissions"), same template discipline as COULD_NOT_JOIN.
    const reason = templateReason(opts.recallReason ?? COULD_NOT_RECORD_FALLBACK_REASON);
    return {
      status,
      label: "Couldn't record",
      kind: "error",
      message: `Couldn't start recording — ${reason}.`,
      code: "SAMO-CALL-NOREC",
      hint: "Check the meeting's recording permissions, then add the call again.",
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
      hint: "A host removed samograph from the meeting.",
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
