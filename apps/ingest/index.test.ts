import { describe, it, expect } from "bun:test";
import { HEALTH_MARKER, probeTunnelHealth } from "../../src/server.ts";
import { SERVICE_NAME, handler } from "./index.ts";

describe("@samograph/ingest", () => {
  it("service name is ingest", () => {
    expect(SERVICE_NAME).toBe("ingest");
  });

  it("GET /health returns the samograph-health marker (byte-match the CLI marker, §4.5)", async () => {
    const res = handler(new Request("http://ingest.local/health?nonce=abc123"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // The marker is byte-identical to the CLI's src/server.ts HEALTH_MARKER, so a
    // regional cloudflared /health round-trip can never pass on an interstitial.
    expect(HEALTH_MARKER).toBe("samograph-health");
    expect(body).toEqual({ ok: true, nonce: "abc123", marker: "samograph-health" });
  });

  it("GET /health passes the CLI's own probeTunnelHealth round-trip", async () => {
    // Route the CLI watchdog's probe straight at the ingest handler: same nonce +
    // marker contract the §4.5 regional watchdog uses. ok === true proves parity.
    const probe = await probeTunnelHealth(
      "http://ingest.local",
      async (url) => handler(new Request(url)),
      () => "nonce-roundtrip",
    );
    expect(probe).toEqual({ ok: true, ngrokErrorCode: null });
  });

  it("unknown route returns 404", () => {
    expect(handler(new Request("http://ingest.local/nope")).status).toBe(404);
  });
});
