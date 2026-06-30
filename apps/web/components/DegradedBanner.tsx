"use client";

import { formatRenderLine, type TranscriptLine } from "../lib/transcriptView.ts";

/**
 * Centralized banner copy (SPEC §3 Story 5). Exported so tests assert the exact
 * string and the per-call page never duplicates it.
 */
export const DEGRADED_BANNER_COPY = "Transcript delivery degraded — recovering…";

export interface DegradedBannerProps {
  /** The `ingest_degraded` overlay (SPEC §5.10). */
  degraded: boolean;
}

/**
 * Mid-call tunnel/ingest-degraded banner (SPEC §3 Story 5, §4.5, §5.10). Shows
 * the live-region warning when `degraded` is true, renders nothing when false.
 * Driven by the `ingest_degraded` overlay AND the inline `SAMOGRAPH-WARNING`
 * lines — both flip `degraded` in the reducer (dual-driver), the page just reads
 * the resulting boolean.
 */
export function DegradedBanner({ degraded }: DegradedBannerProps) {
  if (!degraded) return null;
  // `role="status"` + an explicit assertive live region so the warning is
  // announced immediately the moment ingest degrades mid-call (Story 5).
  return (
    <div role="status" aria-live="assertive" className="samograph-degraded-banner">
      {DEGRADED_BANNER_COPY}
    </div>
  );
}

export interface WarningLineProps {
  line: TranscriptLine;
}

/**
 * Renders an inline `SAMOGRAPH-WARNING` transcript line marked as a system note
 * (`role="note"`) so a screen reader / the eye never mistakes it for a meeting
 * utterance, while keeping it in `seq` order in the transcript flow.
 */
export function WarningLine({ line }: WarningLineProps) {
  return (
    <p role="note" className="samograph-warning-line">
      {formatRenderLine(line)}
    </p>
  );
}
