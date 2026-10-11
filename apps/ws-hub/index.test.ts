import { describe, it, expect } from "bun:test";
import { SERVICE_NAME, handler } from "./index.ts";

describe("@samograph/ws-hub", () => {
  it("service name is ws-hub", () => {
    expect(SERVICE_NAME).toBe("ws-hub");
  });

  it("GET /health returns 200 'ok'", async () => {
    const res = handler(new Request("http://ws-hub.local/health"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("unknown route returns 404", () => {
    expect(handler(new Request("http://ws-hub.local/nope")).status).toBe(404);
  });
});
