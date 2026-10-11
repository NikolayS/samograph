import { describe, it, expect } from "bun:test";
import { SERVICE_NAME, handler } from "./index.ts";

describe("@samograph/bot-worker", () => {
  it("service name is bot-worker", () => {
    expect(SERVICE_NAME).toBe("bot-worker");
  });

  it("GET /health returns 200 'ok'", async () => {
    const res = handler(new Request("http://bot-worker.local/health"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("unknown route returns 404", () => {
    expect(handler(new Request("http://bot-worker.local/nope")).status).toBe(404);
  });
});
