import { describe, expect, test } from "bun:test";
import {
  buildLogRecord,
  formatLogLine,
  MissingLogContextError,
  type LogContext,
} from "./logger.ts";

/**
 * §5.11 / §5.16: structured JSON logs ALWAYS carry non-empty
 * `call_id`/`tenant_id`/`region`. The builder fails closed (throws) on a missing
 * or blank required field so a log line can never silently drop tenant context.
 */
describe("structured logger — §5.11 / §5.16", () => {
  const ctx: LogContext = { call_id: "c1", tenant_id: "t1", region: "eu-central" };

  test("includes the three required fields plus level/msg/ts and extras", () => {
    const rec = buildLogRecord(ctx, "info", "ingest.accepted", { seq: 12, code: "OK" });
    expect(rec.call_id).toBe("c1");
    expect(rec.tenant_id).toBe("t1");
    expect(rec.region).toBe("eu-central");
    expect(rec.level).toBe("info");
    expect(rec.msg).toBe("ingest.accepted");
    expect(rec.seq).toBe(12);
    expect(rec.code).toBe("OK");
    expect(typeof rec.ts).toBe("string");
    expect(rec.ts.length).toBeGreaterThan(0);
  });

  test("formatLogLine emits a single-line parseable JSON object", () => {
    const line = formatLogLine(ctx, "warn", "tunnel.degraded", { region_probe: "fail" });
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line);
    expect(parsed.call_id).toBe("c1");
    expect(parsed.tenant_id).toBe("t1");
    expect(parsed.region).toBe("eu-central");
    expect(parsed.level).toBe("warn");
  });

  test("fuzz: every produced line carries non-empty call_id/tenant_id/region", () => {
    const rnd = (n: number) => Math.random().toString(36).slice(2, 2 + n) + "x";
    for (let i = 0; i < 200; i++) {
      const c: LogContext = { call_id: rnd(3), tenant_id: rnd(4), region: rnd(5) };
      const parsed = JSON.parse(formatLogLine(c, "info", "evt", { i }));
      for (const k of ["call_id", "tenant_id", "region"] as const) {
        expect(typeof parsed[k]).toBe("string");
        expect((parsed[k] as string).length).toBeGreaterThan(0);
      }
    }
  });

  test.each([
    ["call_id", { call_id: "", tenant_id: "t", region: "r" }],
    ["tenant_id", { call_id: "c", tenant_id: "", region: "r" }],
    ["region", { call_id: "c", tenant_id: "t", region: "" }],
    ["whitespace", { call_id: "c", tenant_id: "   ", region: "r" }],
  ] as const)("throws MissingLogContextError when %s is blank", (_label, bad) => {
    expect(() => buildLogRecord(bad as LogContext, "info", "evt")).toThrow(MissingLogContextError);
  });
});
