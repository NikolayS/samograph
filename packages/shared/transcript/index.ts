/**
 * Canonical transcript normalizer — RED stub (intentionally unimplemented).
 *
 * The real implementation lands in the GREEN step of #39. Returning `null`
 * unconditionally makes every exact-value test fail loudly first (strict
 * red/green TDD, SPEC §6.2 #1).
 */
export function normalizeTranscriptLine(_payload: unknown): string | null {
  return null;
}
