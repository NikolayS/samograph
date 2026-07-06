import { describe, it, expect } from "bun:test";
import type { CallStatus } from "./appApiClient.ts";
import { statusView, type StatusKind } from "./callStatusView.ts";

describe("statusView — 7 statuses → label/kind/terminal (SPEC §5.2)", () => {
  const cases: Array<{
    status: CallStatus;
    label: string;
    kind: StatusKind;
    message: string;
    isTerminal: boolean;
  }> = [
    { status: "PENDING", label: "Starting", kind: "pending", message: "Setting up samograph…", isTerminal: false },
    { status: "JOINING", label: "Joining", kind: "joining", message: "samograph is joining the call…", isTerminal: false },
    { status: "IN_CALL", label: "Live", kind: "live", message: "Live transcript is streaming.", isTerminal: false },
    { status: "ENDED", label: "Ended", kind: "ended", message: "This call has ended.", isTerminal: true },
    { status: "COULD_NOT_RECORD", label: "Couldn't record", kind: "error", message: "Couldn't start recording — check meeting permissions.", isTerminal: true },
    { status: "BOT_REMOVED", label: "Bot removed", kind: "error", message: "The bot was removed from the call.", isTerminal: true },
  ];

  for (const c of cases) {
    it(`${c.status} → ${c.label} / ${c.kind}`, () => {
      const v = statusView(c.status);
      expect(v.label).toBe(c.label);
      expect(v.kind).toBe(c.kind);
      expect(v.message).toBe(c.message);
      expect(v.isTerminal).toBe(c.isTerminal);
    });
  }
});

describe("statusView — error codes (SPEC §5.16)", () => {
  it("COULD_NOT_JOIN surfaces the Recall reason + SAMO-CALL-JOIN", () => {
    const v = statusView("COULD_NOT_JOIN", { recallReason: "meeting has not started" });
    expect(v.kind).toBe("error");
    expect(v.code).toBe("SAMO-CALL-JOIN");
    expect(v.message).toBe("Couldn't join — meeting has not started.");
    expect(v.isTerminal).toBe(true);
  });

  it("COULD_NOT_JOIN falls back cleanly when no reason is given (no double punctuation)", () => {
    const v = statusView("COULD_NOT_JOIN");
    expect(v.message).toBe("Couldn't join — the meeting couldn't be reached.");
    expect(v.code).toBe("SAMO-CALL-JOIN");
  });

  it("a Recall reason that already ends with a period is not doubled", () => {
    const v = statusView("COULD_NOT_JOIN", { recallReason: "denied entry." });
    expect(v.message).toBe("Couldn't join — denied entry.");
  });

  it("COULD_NOT_RECORD → SAMO-CALL-NOREC", () => {
    expect(statusView("COULD_NOT_RECORD").code).toBe("SAMO-CALL-NOREC");
  });

  it("COULD_NOT_RECORD surfaces the persisted reason when one exists (§5.16)", () => {
    const v = statusView("COULD_NOT_RECORD", {
      recallReason: "recording_permission_denied_by_host",
    });
    expect(v.kind).toBe("error");
    expect(v.code).toBe("SAMO-CALL-NOREC");
    expect(v.message).toBe("Couldn't start recording — recording_permission_denied_by_host.");
    expect(v.showTryAgain).toBe(false);
  });

  it("COULD_NOT_RECORD keeps the §5.16 fallback copy when no reason is given", () => {
    expect(statusView("COULD_NOT_RECORD").message).toBe(
      "Couldn't start recording — check meeting permissions.",
    );
  });

  it("BOT_REMOVED → SAMO-CALL-REMOVED", () => {
    expect(statusView("BOT_REMOVED").code).toBe("SAMO-CALL-REMOVED");
  });

  it("non-failure statuses carry no code", () => {
    for (const s of ["PENDING", "JOINING", "IN_CALL", "ENDED"] as CallStatus[]) {
      expect(statusView(s).code).toBeUndefined();
    }
  });
});

describe("statusView — showTryAgain is true ONLY for COULD_NOT_JOIN (Story 4)", () => {
  const all: CallStatus[] = [
    "PENDING",
    "JOINING",
    "IN_CALL",
    "ENDED",
    "COULD_NOT_JOIN",
    "COULD_NOT_RECORD",
    "BOT_REMOVED",
  ];
  for (const s of all) {
    it(`${s} → showTryAgain ${s === "COULD_NOT_JOIN"}`, () => {
      expect(statusView(s).showTryAgain).toBe(s === "COULD_NOT_JOIN");
    });
  }
});
