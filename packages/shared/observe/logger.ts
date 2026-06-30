/**
 * Structured JSON logging (SPEC §5.11, §5.16).
 *
 * Every log line is a single JSON object that ALWAYS carries non-empty
 * `call_id`, `tenant_id` and `region` so a line can never lose tenant/call
 * context. The builder FAILS CLOSED — it throws {@link MissingLogContextError}
 * when any required field is missing or blank (whitespace-only) — rather than
 * silently emitting a context-less line.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** The always-present context required on every structured log line (§5.11). */
export interface LogContext {
  call_id: string;
  tenant_id: string;
  region: string;
}

/** A fully-built structured log record. */
export interface StructuredLogRecord extends LogContext {
  level: LogLevel;
  msg: string;
  /** ISO-8601 timestamp. */
  ts: string;
  [key: string]: unknown;
}

/** Thrown when a required log-context field is missing or blank. */
export class MissingLogContextError extends Error {
  constructor(field: keyof LogContext) {
    super(`structured log requires a non-empty ${field}`);
    this.name = "MissingLogContextError";
  }
}

const REQUIRED_FIELDS: ReadonlyArray<keyof LogContext> = ["call_id", "tenant_id", "region"];

function assertContext(ctx: LogContext): void {
  for (const field of REQUIRED_FIELDS) {
    const value = ctx[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new MissingLogContextError(field);
    }
  }
}

/**
 * Build a structured log record, validating the required context. Extra fields
 * are merged in but cannot override `level`/`msg`/`ts` or the required context.
 */
export function buildLogRecord(
  ctx: LogContext,
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
  now: () => Date = () => new Date(),
): StructuredLogRecord {
  assertContext(ctx);
  return {
    ...fields,
    call_id: ctx.call_id,
    tenant_id: ctx.tenant_id,
    region: ctx.region,
    level,
    msg,
    ts: now().toISOString(),
  };
}

/** Build a record and serialize it to a single-line JSON string. */
export function formatLogLine(
  ctx: LogContext,
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
  now: () => Date = () => new Date(),
): string {
  return JSON.stringify(buildLogRecord(ctx, level, msg, fields, now));
}

/** A context-bound logger that writes formatted lines to a sink (default stdout). */
export function createLogger(
  ctx: LogContext,
  write: (line: string) => void = (line) => console.log(line),
) {
  assertContext(ctx);
  const log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) =>
    write(formatLogLine(ctx, level, msg, fields));
  return {
    debug: (msg: string, fields?: Record<string, unknown>) => log("debug", msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) => log("info", msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => log("warn", msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => log("error", msg, fields),
  };
}
