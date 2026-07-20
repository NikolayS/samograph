/**
 * ws-hub transcript FAN-IN — the consuming half of the §5.5 pub/sub seam and the
 * #98 fix (SPEC §5.5, §5.10; issues #99 / #98).
 *
 * Ingest publishes a LIGHTWEIGHT {@link TranscriptSignal} (never the full line —
 * #98): a line carries only `{ call_id, seq }`. This module is the consumer that
 * RE-HYDRATES the signal into a full frame and pushes it onto the in-process
 * {@link Hub} that fans out to subscribed WS connections:
 *
 *   • a `line` signal → resolve the call's tenant (privileged, pre-tenant
 *     lookup), then read the row by `(call_id, seq)` from `transcripts` UNDER
 *     RLS (`SET LOCAL ROLE samograph_app` + `app.tenant_id`, §5.10) — a foreign
 *     call returns zero rows — and `hub.publish` the full line frame.
 *   • a `ctl` signal carries its frame inline. A `{type:"status"}` frame (#106)
 *     is published verbatim onto the Hub's control lane so the per-call page
 *     updates live without a reload — the poller/lifecycle emit it on the SAME
 *     per-call NOTIFY channel as line signals. The remaining ctl types (tunnel
 *     warning / degraded) are still a tracked FOLLOW-UP (the dashboard banner
 *     reads `ingest_degraded` from Postgres).
 *
 * The LISTEN transport that delivers signals from ingest to this fan-in is NOT
 * here: Bun's built-in SQL has no `LISTEN`/`NOTIFY` consumer API, so v1 composes
 * ingest + ws-hub in ONE process and bridges the signal in-process AFTER the
 * dedup tx commits (`apps/ws-hub/liveBridge.ts`). The cross-process `pg_notify`
 * publisher (`PgListenNotifyPublisher`) ships with the same signal shape for the
 * future split, consumed by this exact `deliver`.
 */
import type { SQL } from "bun";
import { setTenant } from "../../packages/shared/db/client.ts";
import type {
  TranscriptControlFrame,
  TranscriptLineFrame,
  TranscriptSignal,
} from "../../packages/shared/transcript/publisher.ts";
import type { ControlFrame, DataFrame, Hub } from "./hub.ts";

/** Injected collaborators for {@link createFanIn}. */
export interface FanInDeps {
  /** Privileged connection able to `SET LOCAL ROLE samograph_app`. */
  sql: SQL;
  /** The in-process fan-out hub WS connections subscribe to. */
  hub: Hub;
  /** Privileged (pre-tenant) call→tenant resolver; `null` when the call is unknown. */
  lookupCallTenant: (callId: string) => Promise<string | null>;
}

/** The live consumer that turns ingest signals into Hub frames. */
export interface FanIn {
  /**
   * Deliver ONE signal to the Hub. A `line` signal is re-hydrated by seq under
   * RLS and published; a missing/foreign row publishes nothing. Returns the
   * published line frame (or `null` for a no-op / control frame), for tests.
   */
  deliver(signal: TranscriptSignal): Promise<TranscriptLineFrame | null>;
}

/** Canonical `YYYY-MM-DD HH:MM:SS` (UTC) — matches the live pipeline line frame (§5.4). */
function canonicalTs(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

interface TranscriptRow {
  ts: Date | string;
  speaker: string | null;
  text: string;
  /** Line kind (#195): 'speech' (default) or 'chat'. */
  kind?: string | null;
}

/**
 * Read one transcript line by `(callId, seq)` under the call's tenant (RLS) and
 * shape it as the canonical live line frame, or `null` when the row is absent /
 * the call belongs to another tenant. Exported for direct unit testing.
 */
export async function fetchLineFrame(
  sql: SQL,
  tenantId: string,
  callId: string,
  seq: number,
): Promise<TranscriptLineFrame | null> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE samograph_app");
    await setTenant(tx as unknown as SQL, tenantId);
    const rows = (await tx`
      SELECT ts, speaker, text, kind FROM transcripts
      WHERE call_id = ${callId} AND seq = ${seq}`) as unknown as TranscriptRow[];
    if (rows.length === 0) return null;
    const row = rows[0];
    const frame: TranscriptLineFrame = {
      type: "line",
      call_id: callId,
      seq,
      ts: canonicalTs(row.ts),
      speaker: row.speaker ?? "",
      text: row.text,
    };
    // Re-hydrate the KIND the ingest pipeline persisted (#195): a chat line
    // carries `kind='chat'` so the stream renders `Name (chat):`; a spoken line
    // omits `kind` entirely (backward-compatible frame shape).
    if (row.kind === "chat") frame.kind = "chat";
    return frame;
  });
}

/** Build the live fan-in over a Hub + a privileged connection. */
export function createFanIn(deps: FanInDeps): FanIn {
  return {
    async deliver(signal) {
      if (signal.k === "ctl") {
        // A status change is live-forwarded verbatim on the control lane (#106);
        // warning/degraded live lanes remain a follow-up. Control frames carry
        // no transcript content, so no RLS re-hydration is needed — the Hub only
        // reaches subscribers already authorized for this call at upgrade (§5.6).
        if (signal.frame.type === "status") {
          deps.hub.publishControl(signal.frame.call_id, signal.frame as unknown as ControlFrame);
        }
        return null;
      }
      const tenantId = await deps.lookupCallTenant(signal.call_id);
      if (!tenantId) return null;
      const frame = await fetchLineFrame(deps.sql, tenantId, signal.call_id, signal.seq);
      if (!frame) return null;
      // The line frame is a fixed-shape DataFrame (carries the monotonic `seq`).
      deps.hub.publish(signal.call_id, frame as unknown as DataFrame);
      return frame;
    },
  };
}

/** A captured control frame (the follow-up lane), re-exported for callers/tests. */
export type { TranscriptControlFrame };
