import type { SQL } from "bun";
import type { MetricsRegistry } from "../../../packages/shared/observe/registry.ts";
import { GoogleCalendarFailure, type GoogleCalendarFailureKind } from "./google-calendar-client.ts";
import type { CreateCallInput, CreateCallResult } from "../calls/create-call.ts";

export const CALENDAR_SYNC_INTERVAL_MS = 5 * 60 * 1000;
export const AUTOJOIN_LEAD_MS = 6 * 60 * 1000;
export const AUTOJOIN_LOOKBACK_MS = 10 * 60 * 1000;
const CONCURRENCY = 4;

export interface CalendarSyncPollerDeps {
  sql: SQL;
  syncConnection(connectionId: string): Promise<number | void>;
  clock?: () => number;
  intervalMs?: number;
  schedule?: (fn: () => void, ms: number) => { stop(): void };
  logger?: { warn(message: string): void };
  metrics?: MetricsRegistry;
  autoJoinStore?: CalendarAutoJoinStore;
  createCall?: (input: CreateCallInput) => Promise<CreateCallResult>;
}

export interface CalendarAutoJoinEvent { providerEventId: string; meetingUrl: string; startsAt: Date; alreadyActive?: boolean }
export interface CalendarAutoJoinStore {
  candidates(connectionId: string, tenantId: string, now: Date, from: Date, to: Date): Promise<CalendarAutoJoinEvent[]>;
}
interface AutoJoinConnection { id: string; tenantId: string; autoJoin: boolean }
interface CalendarAutoJoinDeps {
  store: CalendarAutoJoinStore;
  createCall(input: Extract<CreateCallInput, { source: "calendar" }>): Promise<CreateCallResult>;
  now?: () => Date;
  logger?: { warn(message: string): void };
  metrics?: MetricsRegistry;
}

function sqlstate(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  for (const key of ["code", "errno"]) {
    try { const value = Reflect.get(error, key); if (typeof value === "string" && /^[0-9A-Z]{5}$/.test(value)) return value; } catch {}
  }
  return null;
}

export async function runCalendarAutoJoin(connection: AutoJoinConnection, deps: CalendarAutoJoinDeps): Promise<void> {
  if (!connection.autoJoin) return;
  const now = deps.now?.() ?? new Date();
  const events = await deps.store.candidates(
    connection.id,
    connection.tenantId,
    now,
    new Date(now.getTime() - AUTOJOIN_LOOKBACK_MS),
    new Date(now.getTime() + AUTOJOIN_LEAD_MS),
  );
  for (const event of events) {
    if (event.alreadyActive) {
      deps.metrics?.incCalendarAutoJoin("already_active");
      continue;
    }
    try {
      const result = await deps.createCall({ tenantId: connection.tenantId, actor: "calendar-autojoin", meetingUrl: event.meetingUrl, source: "calendar", sourceEventId: `${connection.id}:${event.providerEventId}` });
      deps.metrics?.incCalendarAutoJoin(result.kind);
      if (result.kind !== "created" && result.kind !== "duplicate" && result.kind !== "already_active") deps.logger?.warn(`[calendar-autojoin] connection ${connection.id} event ${event.providerEventId} result: ${result.kind}`);
    } catch (error) {
      deps.metrics?.incCalendarAutoJoin("unexpected");
      deps.logger?.warn(`[calendar-autojoin] connection ${connection.id} event ${event.providerEventId} result: unexpected sqlstate=${sqlstate(error) ?? "unknown"}`);
    }
  }
}

export interface CalendarSyncPollerHandle {
  tick(): Promise<void>;
  stop(): void;
}

function defaultSchedule(fn: () => void, ms: number): { stop(): void } {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

function category(error: unknown): GoogleCalendarFailureKind | "unexpected" {
  return error instanceof GoogleCalendarFailure ? error.kind : "unexpected";
}

export function startCalendarSyncPoller(deps: CalendarSyncPollerDeps): CalendarSyncPollerHandle {
  const clock = deps.clock ?? Date.now;
  const retryUntil = new Map<string, number>();
  let inFlight = false;

  async function refreshGauges(): Promise<void> {
    if (!deps.metrics) return;
    const rows = await deps.sql`
      SELECT status, count(*)::int AS count,
             CASE WHEN status = 'connected' THEN
               EXTRACT(EPOCH FROM (now() - min(COALESCE(last_sync_at, connected_at))))::double precision
             ELSE NULL END AS sync_age_seconds
        FROM calendar_connections
       GROUP BY status` as unknown as Array<{ status: "connected" | "broken"; count: number; sync_age_seconds: number | null }>;
    const counts = new Map(rows.map((row) => [row.status, Number(row.count)]));
    deps.metrics.setCalendarConnections("connected", counts.get("connected") ?? 0);
    deps.metrics.setCalendarConnections("broken", counts.get("broken") ?? 0);
    const ages = rows.map((row) => row.sync_age_seconds).filter((age): age is number => age !== null).map(Number);
    deps.metrics.setCalendarSyncAgeSeconds(ages.length ? Math.max(0, Math.max(...ages)) : 0);
  }

  async function syncOne(connection: { id: string; tenant_id?: string; auto_join?: boolean }): Promise<void> {
    const id = connection.id;
    if ((retryUntil.get(id) ?? 0) > clock()) return;
    try {
      const events = await deps.syncConnection(id);
      retryUntil.delete(id);
      deps.metrics?.incCalendarSync("ok");
      deps.metrics?.incCalendarSyncEvents(events ?? 0);
      if (connection.auto_join && connection.tenant_id && deps.autoJoinStore && deps.createCall) {
        try {
          await runCalendarAutoJoin({ id, tenantId: connection.tenant_id, autoJoin: true }, { store: deps.autoJoinStore, createCall: deps.createCall, now: () => new Date(clock()), logger: deps.logger, metrics: deps.metrics });
        } catch (error) {
          deps.metrics?.incCalendarAutoJoin("unexpected");
          deps.logger?.warn(`[calendar-autojoin] connection ${id} result: unexpected sqlstate=${sqlstate(error) ?? "unknown"}`);
        }
      }
    } catch (error) {
      const failure = category(error);
      if (error instanceof GoogleCalendarFailure && error.retryAfterMs !== undefined) {
        retryUntil.set(id, clock() + error.retryAfterMs);
      }
      deps.metrics?.incCalendarSync(failure);
      deps.logger?.warn(`[calendar-poller] connection ${id} failed: ${failure}`);
    }
  }

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const rows = await deps.sql`
        SELECT id,tenant_id,auto_join FROM calendar_connections WHERE status = 'connected' ORDER BY id` as unknown as Array<{ id: string; tenant_id?: string; auto_join?: boolean }>;
      const selectedIds = new Set(rows.map((row) => row.id));
      const now = clock();
      for (const [id, deadline] of retryUntil) {
        if (!selectedIds.has(id) || deadline <= now) retryUntil.delete(id);
      }
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
        while (next < rows.length) {
          const row = rows[next++];
          if (row) await syncOne(row);
        }
      }));
      await refreshGauges();
    } catch {
      deps.metrics?.incCalendarSync("sweep_failed");
      deps.logger?.warn("[calendar-poller] sweep failed: sweep_failed");
    } finally {
      inFlight = false;
    }
  }

  const scheduled = (deps.schedule ?? defaultSchedule)(() => void tick(), deps.intervalMs ?? CALENDAR_SYNC_INTERVAL_MS);
  return { tick, stop: () => scheduled.stop() };
}
