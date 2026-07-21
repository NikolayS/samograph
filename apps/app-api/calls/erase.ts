/**
 * Reusable per-call erasure primitives (SPEC §5.14 GDPR).
 *
 * Extracted from the #201 `DELETE /calls/:id` route so BOTH the per-call delete
 * AND the whole-account erase (`DELETE /account`) drive the SAME cascade + Recall
 * side-effects — the account flow just loops these over every call in the tenant.
 *
 * The two concerns are deliberately split:
 *   - {@link eraseCallRecording} runs the Recall side-effects OUTSIDE any DB
 *     transaction (no network call holds a tx open), force-leaving a still-LIVE
 *     bot FIRST, then erasing its recording.
 *   - {@link purgeCallRows} deletes the call + its child rows INSIDE the caller's
 *     RLS-scoped (`samograph_app` + `app.tenant_id`) transaction, so a
 *     cross-tenant row is invisible and cannot be touched.
 */
import type { SQL } from "bun";
import type { CallRecordingControl } from "../../bot-orchestrator/recallClient.ts";

/**
 * The TERMINAL call statuses (§5.2 / the 0002 `reset_ingest_degraded` trigger):
 * a call in one of these has NO live bot. Any OTHER status (`PENDING`, `JOINING`,
 * `IN_CALL`) is treated as LIVE for the §5.14 delete, so its bot is force-left
 * BEFORE the row is purged.
 */
export const TERMINAL_CALL_STATUSES = new Set([
  "ENDED",
  "COULD_NOT_JOIN",
  "COULD_NOT_RECORD",
  "BOT_REMOVED",
]);

/** True when the call may still have a bot in the meeting (non-terminal, §5.14). */
export function callMayBeLive(status: string): boolean {
  return !TERMINAL_CALL_STATUSES.has(status);
}

/**
 * Recall side-effects for erasing ONE call (§5.14), run OUTSIDE the DB tx. A
 * still-LIVE bot is force-left FIRST (the SAME `leave_call` path `act:leave` /
 * `samograph leave` use), THEN its recording is erased (`delete_media`). A call
 * with no `recall_bot_id` (never got a bot) is a no-op.
 */
export async function eraseCallRecording(
  recall: CallRecordingControl,
  call: { botId: string | null; status: string },
): Promise<void> {
  if (!call.botId) return;
  if (callMayBeLive(call.status)) await recall.leave(call.botId);
  await recall.deleteRecording(call.botId);
}

/**
 * Purge a call's rows in FK-safe order (children → parent) INSIDE the caller's
 * RLS-scoped transaction: transcripts, capability/share tokens, its workers row,
 * then the `calls` row itself (whose ON DELETE CASCADE / SET NULL FKs sweep any
 * table not enumerated here). MUST run under `SET LOCAL ROLE samograph_app` with
 * `app.tenant_id` set, so RLS confines every delete to the caller's tenant.
 */
export async function purgeCallRows(tx: SQL, callId: string): Promise<void> {
  await tx`DELETE FROM transcripts WHERE call_id = ${callId}`;
  await tx`DELETE FROM tokens WHERE call_id = ${callId}`;
  await tx`DELETE FROM workers WHERE call_id = ${callId}`;
  await tx`DELETE FROM calls WHERE id = ${callId}`;
}
