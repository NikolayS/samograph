/**
 * KID-addressed HMAC signing keyring (SPEC §5.1 KID rotation).
 *
 * Keys rotate every 90 days; during a 30-day overlap BOTH the current and the
 * previous KID are accepted, so links minted just before a rotation still
 * verify. New links are always signed with the current KID. A token whose KID
 * is not in the keyring (rotated out, or attacker-chosen) is rejected — this is
 * the "tampered KID → 401" case (§6.2 #6).
 */
import { hmacSha256 } from "./crypto.ts";

export class SigningKeyring {
  readonly #keys: Map<string, string>;
  readonly #currentKid: string;

  /**
   * @param currentKid KID used to sign new links — MUST be present in `keys`.
   * @param keys map of accepted `kid → secret` (current + any overlap-window previous).
   */
  constructor(currentKid: string, keys: Record<string, string>) {
    this.#keys = new Map(Object.entries(keys));
    if (!this.#keys.has(currentKid)) {
      throw new Error(`current KID ${currentKid} is not in the keyring`);
    }
    this.#currentKid = currentKid;
  }

  /** The KID new links are signed with. */
  get currentKid(): string {
    return this.#currentKid;
  }

  /** True iff `kid` is accepted (current OR within the overlap window). */
  accepts(kid: string): boolean {
    return this.#keys.has(kid);
  }

  /** HMAC-SHA256 the signing input under `kid` (default: the current KID). */
  sign(signingInput: string, kid: string = this.#currentKid): Buffer {
    const secret = this.#keys.get(kid);
    if (secret === undefined) throw new Error(`unknown KID: ${kid}`);
    return hmacSha256(secret, signingInput);
  }
}
