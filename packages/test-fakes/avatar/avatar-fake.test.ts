import { describe, it, expect } from "bun:test";
import type { AvatarProvider } from "../../../src/avatar.ts";
import { createAvatarFake } from "./index.ts";

describe("avatar fake", () => {
  it("structurally satisfies AvatarProvider", () => {
    const provider: AvatarProvider = createAvatarFake({ seed: "s1" });
    expect(provider.name).toBe("anam-fake");
  });

  it("mints a deterministic token for a (seed, persona) pair", async () => {
    const a = await createAvatarFake({ seed: "s1" }).mintSession("persona-x");
    const b = await createAvatarFake({ seed: "s1" }).mintSession("persona-x");
    expect(a.sessionToken).toBe(b.sessionToken);
    expect(a.personaId).toBe("persona-x");
    expect(a.expiresAt).toBeNull();
  });

  it("different seeds or personas yield different tokens", async () => {
    const base = await createAvatarFake({ seed: "s1" }).mintSession("persona-x");
    const otherSeed = await createAvatarFake({ seed: "s2" }).mintSession("persona-x");
    const otherPersona = await createAvatarFake({ seed: "s1" }).mintSession("persona-y");
    expect(otherSeed.sessionToken).not.toBe(base.sessionToken);
    expect(otherPersona.sessionToken).not.toBe(base.sessionToken);
  });

  it("records minted persona ids in call order", async () => {
    const fake = createAvatarFake({ seed: "s1" });
    await fake.mintSession("p1");
    await fake.mintSession("p2");
    expect(fake.minted).toEqual(["p1", "p2"]);
  });

  it("never performs I/O (no real key needed)", async () => {
    // No ANAM_API_KEY set, no network — the fake still mints.
    const session = await createAvatarFake({ seed: "offline" }).mintSession("p");
    expect(session.sessionToken).toMatch(/^sess_[0-9a-f]{8}$/);
  });
});
