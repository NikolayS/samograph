import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { apiKey, ExitError } from "../src/config.ts";
import { saveEnv, restoreEnv } from "./helpers.ts";

describe("apiKey", () => {
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    env = saveEnv();
  });
  afterEach(() => {
    restoreEnv(env);
  });

  it("returns key when set", () => {
    process.env.RECALL_API_KEY = "test-key-123";
    expect(apiKey()).toBe("test-key-123");
  });

  it("exits when not set", () => {
    delete process.env.RECALL_API_KEY;
    let code = -1;
    try {
      apiKey();
    } catch (e) {
      expect(e).toBeInstanceOf(ExitError);
      code = (e as ExitError).code;
    }
    expect(code).toBe(1);
  });

  it("exits when empty string", () => {
    process.env.RECALL_API_KEY = "";
    let code = -1;
    try {
      apiKey();
    } catch (e) {
      code = (e as ExitError).code;
    }
    expect(code).toBe(1);
  });

  it("error message on missing key (throws ExitError)", () => {
    delete process.env.RECALL_API_KEY;
    expect(() => apiKey()).toThrow(ExitError);
  });
});
