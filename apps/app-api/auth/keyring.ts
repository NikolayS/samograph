/**
 * KID-addressed HMAC signing keyring (SPEC §5.1 KID rotation).
 *
 * Keys rotate every 90 days; during a 30-day overlap BOTH the current and the
 * previous KID are accepted, so links minted just before a rotation still
 * verify. New links are always signed with the current KID. A token whose KID
 * is not in the keyring (rotated out, or attacker-chosen) is rejected — this is
 * the "tampered KID → 401" case (§6.2 #6).
 */

export class SigningKeyring {
  constructor(_currentKid: string, _keys: Record<string, string>) {
    throw new Error("not implemented: SigningKeyring");
  }

  /** The KID new links are signed with. */
  get currentKid(): string {
    throw new Error("not implemented: currentKid");
  }

  /** True iff `kid` is accepted (current OR within the overlap window). */
  accepts(_kid: string): boolean {
    throw new Error("not implemented: accepts");
  }

  /** HMAC-SHA256 the signing input under `kid` (default: the current KID). */
  sign(_signingInput: string, _kid?: string): Buffer {
    throw new Error("not implemented: sign");
  }
}
