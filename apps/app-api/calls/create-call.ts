import type { SQL } from "bun";
import type { OrchestratorJob } from "../../bot-orchestrator/index.ts";
import { setTenant } from "../../../packages/shared/db/client.ts";
import { resolveKeyterms } from "../../../packages/shared/settings/index.ts";
import type { RateLimiter } from "../auth/rate-limit.ts";
import { readTenantSettings } from "../settings/store.ts";
import { validateMeetingUrl } from "./validate.ts";
import { tenantActive } from "../auth/owner-session.ts";

export const BOT_CREATE_PER_TENANT_LIMIT = 30;
/** Calendar auto-join has an independent per-tenant budget so it cannot starve manual calls. */
export const AUTO_CREATE_PER_TENANT_LIMIT = 10;
export const BOT_CREATE_WINDOW_MS = 60 * 60 * 1000;
export const RECALL_COST_CODE = "SAMO-RECALL-COST" as const;
export const CALL_ACTIVE_CODE = "SAMO-CALL-ACTIVE" as const;

const UNIQUE_VIOLATION = "23505";
const SOURCE_EVENT_UNIQUE_CONSTRAINT = "calls_tenant_source_event_unique_idx";

export function autoJoinLockKey(tenantId: string, url: string): string {
  return `${tenantId}:${url}`;
}

interface CreateCallInputBase {
  tenantId: string;
  actor: string;
  meetingUrl: unknown;
}

export type CreateCallInput = CreateCallInputBase & (
  | { source: "manual"; sourceEventId?: never }
  | { source: "calendar"; sourceEventId: string }
);

export interface CreateCallDeps {
  sql: SQL;
  enqueue: (job: OrchestratorJob) => void | Promise<void>;
  rateLimiter: RateLimiter;
  now: () => number;
}

export type CreateCallResult =
  | { kind: "created"; call: { id: string; status: string } }
  | { kind: "already_active"; callId: string }
  | { kind: "invalid_url" }
  | { kind: "tenant_inactive" }
  | { kind: "cost_cap"; retryAfterMs: number }
  | { kind: "duplicate" };

export async function createCallForTenant(
  input: CreateCallInput,
  deps: CreateCallDeps,
): Promise<CreateCallResult> {
  const valid = validateMeetingUrl(input.meetingUrl);
  if (!valid.ok) return { kind: "invalid_url" };
  if (!(await tenantActive(deps.sql, input.tenantId))) return { kind: "tenant_inactive" };

  const isAutoJoin = input.source === "calendar";
  const rateKey = isAutoJoin ? `bot-create:auto:${input.tenantId}` : `bot-create:${input.tenantId}`;
  const rateLimit = isAutoJoin ? AUTO_CREATE_PER_TENANT_LIMIT : BOT_CREATE_PER_TENANT_LIMIT;
  const rateNow = deps.now();
  const reservation = await deps.rateLimiter.hit(
    rateKey, rateLimit, BOT_CREATE_WINDOW_MS, rateNow,
  );
  if (!reservation.allowed) return { kind: "cost_cap", retryAfterMs: reservation.retryAfterMs };

  let transactionResult:
    | { kind: "created"; call: { id: string; status: string } }
    | { kind: "already_active"; callId: string };
  try {
    transactionResult = await deps.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await setTenant(tx, input.tenantId);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${autoJoinLockKey(input.tenantId, valid.url)}))`;

      const active = await tx`
        SELECT id FROM calls
        WHERE tenant_id=${input.tenantId}
          AND meeting_url=${valid.url}
          AND created_at > now() - interval '4 hours'
          AND status NOT IN ('ENDED','COULD_NOT_JOIN','COULD_NOT_RECORD','BOT_REMOVED')
        ORDER BY created_at DESC, id
        LIMIT 1` as unknown as Array<{ id: string }>;
      if (active[0]) return { kind: "already_active", callId: active[0].id };

      const rows = await tx`
        INSERT INTO calls (tenant_id, meeting_url, status, ingest_degraded, source, source_event_id)
        VALUES (${input.tenantId}, ${valid.url}, 'PENDING', false, ${input.source}, ${input.sourceEventId})
        RETURNING id, status`;
      const row = rows[0] as { id: string; status: string };
      await tx`
        INSERT INTO audit_log (tenant_id, call_id, actor, action)
        VALUES (${input.tenantId}, ${row.id}, ${input.actor}, 'call.create')`;
      return { kind: "created", call: row };
    });
  } catch (error) {
    await deps.rateLimiter.refund(rateKey, BOT_CREATE_WINDOW_MS, rateNow);
    const pgError = error as {
      errno?: string;
      constraint?: string;
      constraint_name?: string;
    };
    if (
      pgError.errno === UNIQUE_VIOLATION
      && (pgError.constraint ?? pgError.constraint_name) === SOURCE_EVENT_UNIQUE_CONSTRAINT
    ) return { kind: "duplicate" };
    throw error;
  }

  if (transactionResult.kind === "already_active") {
    await deps.rateLimiter.refund(rateKey, BOT_CREATE_WINDOW_MS, rateNow);
    return transactionResult;
  }

  const settings = await readTenantSettings(deps.sql, input.tenantId);
  await deps.enqueue({
    callId: transactionResult.call.id,
    meetingUrl: valid.url,
    keyterms: resolveKeyterms(settings),
    language: settings.language,
  });
  return transactionResult;
}
