/**
 * IdentityStore contract, exercised against the in-memory fake (SPEC §5.1;
 * issue #209 acceptance criteria 7 and 10).
 *
 * The fake is what every service/http test will run on, so it must ENFORCE the
 * invariants the Postgres store enforces in DDL — otherwise the two sides drift
 * and a green service suite proves nothing. The load-bearing one: `link` is an
 * upsert on `(provider, subject)` that refreshes `email` but NEVER moves an
 * existing subject to a different `user_id`. That is the whole reason identity
 * is keyed on the provider's immutable `sub` rather than on the mutable,
 * provider-controlled email (see the same assertions replayed against real DDL
 * in pg-identity-store.db.test.ts).
 */
import { describe, it, expect } from "bun:test";
import { InMemoryUserStore } from "./stores.ts";
import { InMemoryIdentityStore } from "./identities.ts";

describe("InMemoryIdentityStore (§5.1 provider identity)", () => {
  async function seed() {
    const users = new InMemoryUserStore();
    const alice = await users.createOrLoadUser("alice@example.com");
    const bob = await users.createOrLoadUser("bob@example.com");
    return { users, alice, bob, identities: new InMemoryIdentityStore(users) };
  }

  it("links a subject and reads it back with EXACTLY the linked identity", async () => {
    const { alice, identities } = await seed();

    const linked = await identities.link({
      provider: "google",
      subject: "sub-1",
      userId: alice.id,
      email: "alice@example.com",
    });
    expect(linked).toEqual({
      provider: "google",
      subject: "sub-1",
      userId: alice.id,
      tenantId: alice.tenantId,
      email: "alice@example.com",
    });

    expect(await identities.findByProviderSubject("google", "sub-1")).toEqual({
      provider: "google",
      subject: "sub-1",
      userId: alice.id,
      tenantId: alice.tenantId,
      email: "alice@example.com",
    });
  });

  it("returns undefined (never null, never a throw) for an unknown subject", async () => {
    const { identities } = await seed();
    expect(await identities.findByProviderSubject("google", "no-such-sub")).toBeUndefined();
  });

  it("is idempotent on (provider, subject): two links produce ONE record with the SAME user_id", async () => {
    const { alice, identities } = await seed();
    const input = {
      provider: "google" as const,
      subject: "sub-1",
      userId: alice.id,
      email: "alice@example.com",
    };

    const first = await identities.link(input);
    const second = await identities.link(input);

    expect(identities.records.length).toBe(1);
    expect(second.userId).toBe(first.userId);
    expect(second).toEqual(first);
  });

  it("refreshes email on re-link but NEVER moves the subject to a different user_id", async () => {
    const { alice, bob, identities } = await seed();
    await identities.link({
      provider: "google",
      subject: "sub-1",
      userId: alice.id,
      email: "alice@example.com",
    });

    // An attempted re-link of the SAME subject to a DIFFERENT user — the race the
    // `DO UPDATE` deliberately does not resolve in the newcomer's favour.
    const relinked = await identities.link({
      provider: "google",
      subject: "sub-1",
      userId: bob.id,
      email: "alice+new@example.com",
    });

    expect(relinked.userId).toBe(alice.id); // NOT bob.id
    expect(relinked.tenantId).toBe(alice.tenantId);
    expect(relinked.email).toBe("alice+new@example.com");
    expect(identities.records).toEqual([
      {
        provider: "google",
        subject: "sub-1",
        userId: alice.id,
        tenantId: alice.tenantId,
        email: "alice+new@example.com",
      },
    ]);
  });

  it("allows ONE user to hold TWO google identities (no UNIQUE (user_id, provider))", async () => {
    const { alice, identities } = await seed();
    await identities.link({
      provider: "google",
      subject: "sub-personal",
      userId: alice.id,
      email: "alice@example.com",
    });
    await identities.link({
      provider: "google",
      subject: "sub-work",
      userId: alice.id,
      email: "alice@work.example",
    });

    expect(identities.records).toEqual([
      {
        provider: "google",
        subject: "sub-personal",
        userId: alice.id,
        tenantId: alice.tenantId,
        email: "alice@example.com",
      },
      {
        provider: "google",
        subject: "sub-work",
        userId: alice.id,
        tenantId: alice.tenantId,
        email: "alice@work.example",
      },
    ]);
  });

  it("keeps a null email (the provider need not assert one) and starts with no records", async () => {
    const { alice, identities } = await seed();
    expect(identities.records).toEqual([]);

    const linked = await identities.link({
      provider: "google",
      subject: "sub-1",
      userId: alice.id,
      email: null,
    });
    expect(linked.email).toBeNull();
  });

  it("refuses to link an identity to a user that does not exist (the FK, in the fake)", async () => {
    const { identities } = await seed();
    let caught: Error | null = null;
    try {
      await identities.link({
        provider: "google",
        subject: "sub-1",
        userId: "00000000-0000-0000-0000-000000000000",
        email: "ghost@example.com",
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(identities.records).toEqual([]);
  });
});
