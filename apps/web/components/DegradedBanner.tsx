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
 *
 * STUB: renders nothing — implemented in the GREEN commit.
 */
export function DegradedBanner(_props: DegradedBannerProps) {
  return null;
}

export interface WarningLineProps {
  line: TranscriptLine;
}

/**
 * Renders an inline `SAMOGRAPH-WARNING` transcript line marked as a system note
 * (`role="note"`) so a screen reader / the eye never mistakes it for a meeting
 * utterance, while keeping it in `seq` order in the transcript flow.
 *
 * STUB: renders nothing — implemented in the GREEN commit.
 */
export function WarningLine(_props: WarningLineProps) {
  void formatRenderLine;
  return null;
}
