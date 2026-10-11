/**
 * Per-env magic-link callback base (#190 — preview sign-in bounce).
 *
 * The magic-link callback URL MUST resolve to the CURRENT env's own public host.
 * samohost injects `BASE_URL=<the env's own https host>` into every preview env
 * while leaving `WEB_ORIGIN` pointed at prod, so a preview must PREFER `BASE_URL`
 * — otherwise a preview sign-in click lands on prod (`samograph.samo.team`) and
 * the session cookie is set on the wrong origin.
 *
 * These tests exercise the REAL wiring end-to-end: env → resolveMagicLinkBaseUrl
 * → createAppApi(webOrigin) → AuthService → the emitted magic-link email link.
 * requestMagicLink never touches the user store, so a bare `sql` stub is enough
 * (the same pattern app.test.ts uses).
 */
import { describe, it, expect } from "bun:test";
import type { SQL } from "bun";
import { createAppApi, type AppApiConfig } from "../app.ts";
import { InMemoryEmailSender } from "./email.ts";
import { resolveMagicLinkBaseUrl } from "../../../packages/shared/config/env.ts";

const PROD = "https://samograph.samo.team";
const PREVIEW = "https://samograph-somebranch.samo.cat";
const DEFAULT = "https://samograph.dev";

/** Build the composed app-api against a resolved callback base + an in-memory mailbox. */
function buildApi(webOrigin: string) {
  const emailSender = new InMemoryEmailSender();
  const config: AppApiConfig = {
    // requestMagicLink never reaches the PostgresUserStore, so a bare stub is fine.
    sql: {} as unknown as SQL,
    sessionSecret: "base-url-test-session-secret-aaaaaaaaaaaaaaaa",
    magicLinkKid: "test-kid",
    magicLinkSecret: "test-magic-secret",
    tokenKeyring: { current: { kid: "test-share", secret: "test-token-secret" } },
    emailSender,
    webOrigin,
    enqueue: () => {},
  };
  return { api: createAppApi(config), emailSender };
}

/** POST /auth/magic-link; the request URL host + forwarded-host are attacker-controlled. */
const postMagicLink = (host = "api.internal", extraHeaders: Record<string, string> = {}) =>
  new Request(`https://${host}/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ email: "user@example.com" }),
  });

describe("magic-link callback base — per-env origin (#190)", () => {
  it("(a) prefers BASE_URL over WEB_ORIGIN: the callback link is on the BASE_URL host", async () => {
    // samohost preview shape: BASE_URL = the env's own host, WEB_ORIGIN = prod.
    const base = resolveMagicLinkBaseUrl({ BASE_URL: PREVIEW, WEB_ORIGIN: PROD }, DEFAULT);
    expect(base).toBe(PREVIEW); // exact value, not "contains"

    const { api, emailSender } = buildApi(base);
    const res = await api.fetch(postMagicLink());
    expect(res.status).toBe(200);
    expect(emailSender.sent.length).toBe(1);
    const link = emailSender.sent[0].link;
    expect(link.startsWith(`${PREVIEW}/auth/callback?token=`)).toBe(true);
    // and NEVER the prod host — that is the preview-bounce bug.
    expect(link.startsWith(PROD)).toBe(false);
  });

  it("(b) falls back to WEB_ORIGIN when BASE_URL is unset or empty (prod unchanged)", async () => {
    expect(resolveMagicLinkBaseUrl({ WEB_ORIGIN: PROD }, DEFAULT)).toBe(PROD);
    expect(resolveMagicLinkBaseUrl({ BASE_URL: "", WEB_ORIGIN: PROD }, DEFAULT)).toBe(PROD);

    const { api, emailSender } = buildApi(resolveMagicLinkBaseUrl({ WEB_ORIGIN: PROD }, DEFAULT));
    const res = await api.fetch(postMagicLink());
    expect(res.status).toBe(200);
    const link = emailSender.sent[0].link;
    expect(link.startsWith(`${PROD}/auth/callback?token=`)).toBe(true);
  });

  it("(c) SECURITY: the base is the trusted env value, never the request Host / X-Forwarded-Host", async () => {
    const base = resolveMagicLinkBaseUrl({ BASE_URL: PREVIEW, WEB_ORIGIN: PROD }, DEFAULT);
    const { api, emailSender } = buildApi(base);

    // A malicious caller controls the request host + forwarded-host headers.
    const res = await api.fetch(
      postMagicLink("evil.attacker.example", {
        "x-forwarded-host": "evil.attacker.example",
        "forwarded": "host=evil.attacker.example",
      }),
    );
    expect(res.status).toBe(200);
    const link = emailSender.sent[0].link;
    // The callback host stays the trusted env value — the spoofed host is ignored.
    expect(link.startsWith(`${PREVIEW}/auth/callback?token=`)).toBe(true);
    expect(link).not.toContain("evil.attacker.example");
  });
});
