import { describe, expect, it } from "bun:test";
import {
  previewJournalEmailSender,
  resolveHostedWebOrigin,
} from "./hosted-config.ts";

describe("hosted app-api preview config", () => {
  it("uses samohost's generated preview vhost for magic-link callbacks", () => {
    expect(resolveHostedWebOrigin({
      SAMO_ENV: "preview",
      BASE_URL: "https://samograph-pr-175.samo.cat",
    })).toBe("https://samograph-pr-175.samo.cat");
  });

  it("fails closed instead of defaulting a preview callback to production", () => {
    expect(() => resolveHostedWebOrigin({ SAMO_ENV: "preview" })).toThrow("requires samohost's generated BASE_URL");
    expect(() => resolveHostedWebOrigin({
      SAMO_ENV: "preview",
      BASE_URL: "https://samograph.dev",
    })).toThrow("production origin");
    expect(() => resolveHostedWebOrigin({
      SAMO_ENV: "preview",
      WEB_ORIGIN: "https://samograph.dev",
      BASE_URL: "https://samograph-pr-175.samo.cat",
    })).toThrow("must not inherit WEB_ORIGIN");
  });

  it("rejects non-origin and non-HTTPS callback configuration", () => {
    expect(() => resolveHostedWebOrigin({
      SAMO_ENV: "preview",
      BASE_URL: "http://samograph-pr-175.samo.cat",
    })).toThrow("exact HTTPS origin");
    expect(() => resolveHostedWebOrigin({
      SAMO_ENV: "preview",
      BASE_URL: "https://samograph-pr-175.samo.cat/auth/callback",
    })).toThrow("exact HTTPS origin");
  });

  it("keeps the production default outside preview", () => {
    expect(resolveHostedWebOrigin({ SAMO_ENV: "prod" })).toBe("https://samograph.dev");
  });

  it("delivers preview links only through the operator journal sink", async () => {
    const messages: string[] = [];
    const sender = previewJournalEmailSender((message) => messages.push(message));
    await sender.sendMagicLink({
      to: "reviewer@example.test",
      link: "https://samograph-pr-175.samo.cat/auth/callback?token=one-time",
      token: "one-time",
    });
    expect(messages).toEqual([
      "[preview-auth] magic link for reviewer@example.test: https://samograph-pr-175.samo.cat/auth/callback?token=one-time",
    ]);
  });
});
