import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Trusted-proxy runbook coverage (issue #67 / SPEC.amendments item 11).
 *
 * `clientIp()` (apps/app-api/auth/http.ts) trusts the FIRST X-Forwarded-For hop,
 * which is only safe behind a trusted edge/proxy that OVERWRITES (not appends)
 * XFF with the real client IP. app-api must never be exposed directly, or the
 * 20/hr per-IP magic-link limit is spoofable and direct callers collapse into a
 * single 'unknown' bucket. This guards that the operational assumption is
 * documented and indexed for operators.
 */
const RUNBOOK_DIR = join(import.meta.dir, "..", "docs", "runbooks");
const DOC = join(RUNBOOK_DIR, "trusted-proxy.md");
const INDEX = join(RUNBOOK_DIR, "README.md");

describe("docs/runbooks trusted-proxy — issue #67 / SPEC.amendments item 11", () => {
  test("trusted-proxy.md runbook exists", () => {
    expect(existsSync(DOC)).toBe(true);
  });

  test("runbook documents the XFF overwrite-not-append rule and the failure mode", () => {
    const body = readFileSync(DOC, "utf8");
    expect(body).toContain("X-Forwarded-For");
    expect(body).toMatch(/overwrite/i);
    expect(body).toMatch(/append/i);
    expect(body).toContain("clientIp()");
    expect(body).toContain("apps/app-api/auth/http.ts");
    expect(body).toContain("20/hr");
    expect(body).toContain("unknown");
    // never expose app-api directly
    expect(body).toMatch(/never.*expos/i);
  });

  test("runbook cross-links SPEC.amendments item 11", () => {
    const body = readFileSync(DOC, "utf8");
    expect(body).toContain("SPEC.amendments");
    expect(body).toMatch(/item 11/i);
  });

  test("runbook carries a labelled prod infra follow-up (Cloudflare + Caddy XFF)", () => {
    const body = readFileSync(DOC, "utf8");
    expect(body).toContain("Cloudflare");
    expect(body).toContain("Caddy");
    expect(body).toMatch(/follow-up/i);
    // Caddy appends XFF by default — the exact gap that must be normalized.
    expect(body).toMatch(/append/i);
  });

  test("runbooks README index links the new doc", () => {
    const index = readFileSync(INDEX, "utf8");
    expect(index).toContain("trusted-proxy.md");
  });
});
