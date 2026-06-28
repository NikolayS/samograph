/**
 * @samograph/shared — code shared across samograph.dev apps.
 *
 * The transcript normalizer (§6.2 #1) lives here; capability tokens (§6.2 #2)
 * and the tenancy-gate / auth helpers (§6.2 #4) land in their own Sprint-1
 * issues.
 */
export const PACKAGE_NAME = "@samograph/shared";

// Canonical transcript normalizer (#39, SPEC §5.4 / §6.2 #1) — pure, no I/O.
export {
  normalizeTranscriptLine,
  sanitizeTranscriptField,
} from "./transcript/index.ts";
