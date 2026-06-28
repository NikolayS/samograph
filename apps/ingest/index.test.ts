import { describe, it, expect } from "bun:test";
import { SERVICE_NAME, handler } from "./index.ts";

describe("@samograph/ingest", () => {
  it("service name is ingest", () => {
    expect(SERVICE_NAME).toBe("ingest");
  });

  it("GET /health returns 200 'ok'", async () => {
    const res = handler(new Request("http://ingest.local/health"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("unknown route returns 404", () => {
    expect(handler(new Request("http://ingest.local/nope")).status).toBe(404);
  });
});
