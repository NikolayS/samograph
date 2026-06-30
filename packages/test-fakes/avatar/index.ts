/**
 * Deterministic, seedable, network-free in-repo avatar-provider fake.
 *
 * Mirrors the Recall fake (SPEC §6.1): the abstraction ships with its fake from
 * day one so consumers of `AvatarProvider` (the session-token endpoint, the
 * presence-page wiring) can be tested with no Anam account and no tokens.
 *
 * Everything is a pure function of the seed plus arguments — no `Date.now()`, no
 * randomness, no I/O — so minted tokens are BYTE-STABLE across runs and machines.
 */
import type { AvatarProvider, AvatarSession } from "../../../src/avatar.ts";

export interface AvatarFakeOptions {
  seed: string;
}

/** FNV-1a (32-bit) — a tiny, dependency-free, fully deterministic string hash. */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** A network-free AvatarProvider whose tokens are pure of (seed, personaId). */
export class AvatarFake implements AvatarProvider {
  readonly name = "anam-fake";
  readonly seed: string;
  /** Persona ids passed to mintSession, in call order — for test assertions. */
  readonly minted: string[] = [];

  constructor(options: AvatarFakeOptions) {
    this.seed = options.seed;
  }

  async mintSession(personaId: string, voiceId?: string): Promise<AvatarSession> {
    this.minted.push(personaId);
    // Fold voiceId into the token only when provided, so existing callers that
    // pass no voice keep their byte-stable token.
    const key = voiceId ? `${this.seed}|${personaId}|${voiceId}` : `${this.seed}|${personaId}`;
    return {
      sessionToken: `sess_${fnv1a32(key)}`,
      personaId,
      expiresAt: null,
    };
  }
}

export function createAvatarFake(options: AvatarFakeOptions): AvatarFake {
  return new AvatarFake(options);
}
