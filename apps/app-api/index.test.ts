import { describe, it, expect } from "bun:test";
import { SERVICE_NAME, handler } from "./index.ts";

describe("@samograph/app-api", () => {
  it("service name is app-api", () => {
    expect(SERVICE_NAME).toBe("app-api");
  });

  it("GET /health returns 200 'ok'", async () => {
    const res = handler(new Request("http://app-api.local/health"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("unknown route returns 404", () => {
    expect(handler(new Request("http://app-api.local/nope")).status).toBe(404);
  });
});
