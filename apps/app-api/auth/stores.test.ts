import { describe, it, expect } from "bun:test";
import {
  InMemoryMagicLinkStore,
  InMemoryUserStore,
} from "./stores.ts";
import type { MagicLinkRecord } from "./types.ts";

const rec = (jti: string, email: string): MagicLinkRecord => ({
  jti,
  email,
  kid: "k2",
  issuedAt: 1_000,
  expiresAt: 901_000,
  status: "outstanding",
});

describe("auth/stores — InMemoryMagicLinkStore", () => {
  it("consume is single-use: first → consumed, replay → already_consumed", async () => {
    const store = new InMemoryMagicLinkStore();
    await store.issue(rec("j1", "a@x.com"));

    const first = await store.consume("j1");
    expect(first.outcome).toBe("consumed");

    const replay = await store.consume("j1");
    expect(replay.outcome).toBe("already_consumed");

    // A third attempt stays already_consumed (idempotent, never flips back).
    expect((await store.consume("j1")).outcome).toBe("already_consumed");
  });

  it("issuing a newer link for an email supersedes the older outstanding one", async () => {
    const store = new InMemoryMagicLinkStore();
    await store.issue(rec("old", "a@x.com"));
    await store.issue(rec("new", "a@x.com"));

    expect((await store.get("old"))?.status).toBe("superseded");
    expect((await store.get("new"))?.status).toBe("outstanding");

    // Only the newest verifies; the superseded older one cannot be consumed.
    expect((await store.consume("old")).outcome).toBe("superseded");
    expect((await store.consume("new")).outcome).toBe("consumed");
  });

  it("supersession is per-email: a different email is untouched", async () => {
    const store = new InMemoryMagicLinkStore();
    await store.issue(rec("a1", "a@x.com"));
    await store.issue(rec("b1", "b@x.com"));
    await store.issue(rec("a2", "a@x.com")); // supersedes a1 only

    expect((await store.get("a1"))?.status).toBe("superseded");
    expect((await store.get("b1"))?.status).toBe("outstanding");
  });

  it("consume of an unknown jti → not_found", async () => {
    const store = new InMemoryMagicLinkStore();
    expect((await store.consume("nope")).outcome).toBe("not_found");
  });
});

describe("auth/stores — InMemoryUserStore", () => {
  it("creates a user + 1:1 tenant on first login, loads idempotently after", async () => {
    const store = new InMemoryUserStore();
    const u1 = await store.createOrLoadUser("Person@Example.com");
    expect(u1.email).toBe("person@example.com"); // normalized lower-case
    expect(u1.id).toBeTruthy();
    expect(u1.tenantId).toBeTruthy();
    expect(u1.tenantId).not.toBe(u1.id);

    const u2 = await store.createOrLoadUser("person@example.com");
    expect(u2).toEqual(u1); // same user + same tenant, no duplicate
    expect(store.users.size).toBe(1);
  });
});
