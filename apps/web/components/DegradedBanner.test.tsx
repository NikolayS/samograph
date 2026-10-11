import { describe, it, expect } from "bun:test";
import { render } from "@testing-library/react";
import {
  DegradedBanner,
  DEGRADED_BANNER_COPY,
  WarningLine,
} from "./DegradedBanner.tsx";
import type { TranscriptLine } from "../lib/transcriptView.ts";
import { installDom } from "../test/setup.tsx";

installDom();

describe("DegradedBanner (SPEC §3 Story 5, §5.10)", () => {
  it("renders the exact degraded copy in an assertive live region when degraded", () => {
    const { getByRole } = render(<DegradedBanner degraded={true} />);
    const banner = getByRole("status");
    expect(banner.textContent).toBe(DEGRADED_BANNER_COPY);
    expect(banner.getAttribute("aria-live")).toBe("assertive");
  });

  it("centralizes the copy as the exact Story-5 string", () => {
    expect(DEGRADED_BANNER_COPY).toBe("Transcript delivery degraded — recovering…");
  });

  it("renders nothing when not degraded", () => {
    const { container } = render(<DegradedBanner degraded={false} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("WarningLine — inline SAMOGRAPH-WARNING (SPEC §4.5)", () => {
  const warning: TranscriptLine = {
    seq: 7,
    ts: "2026-01-01 00:01:30",
    speaker: "SAMOGRAPH-WARNING",
    text: "tunnel unreachable (ERR_NGROK_727) - transcript may be incomplete",
  };

  it("renders the warning as a marked system note, not a meeting utterance", () => {
    const { getByRole } = render(<WarningLine line={warning} />);
    const note = getByRole("note");
    expect(note.textContent).toBe(
      "[2026-01-01 00:01:30] SAMOGRAPH-WARNING: tunnel unreachable (ERR_NGROK_727) - transcript may be incomplete",
    );
  });
});
