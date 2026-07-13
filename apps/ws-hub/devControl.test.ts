import { describe, expect, it } from "bun:test";
import { shouldStartDevControl } from "./devControl.ts";

describe("dev-control listener policy", () => {
  it("is enabled only by explicit SAMO_ENV=dev", () => {
    expect(shouldStartDevControl({ SAMO_ENV: "dev" })).toBe(true);
  });

  for (const env of [{}, { SAMO_ENV: "prod" }, { SAMO_ENV: "preview" }, { SAMO_ENV: "unknown" }]) {
    it(`is disabled for ${env.SAMO_ENV ?? "an absent SAMO_ENV"}`, () => {
      expect(shouldStartDevControl(env)).toBe(false);
    });
  }
});
