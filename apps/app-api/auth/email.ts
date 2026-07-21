/**
 * Swappable email transport for magic links (SPEC §5.1, §6.2 #6).
 *
 * Sprint 1 ships ONLY the interface + an in-memory fake that records what would
 * have been sent, so the whole auth flow is testable with no provider key and
 * no network. The real transactional provider (Postmark or Resend) plus
 * SPF/DKIM/DMARC is Sprint-3 deliverability work — it implements this same
 * interface, nothing else in the auth flow changes.
 */

export interface MagicLinkEmail {
  to: string;
  link: string;
  token: string;
}

/**
 * The confirmation sent AFTER a §5.14 account erasure completes ("your account
 * and all its data have been deleted"). Carries only the recipient — there is no
 * link or token, the account no longer exists.
 */
export interface AccountDeletionEmail {
  to: string;
}

export interface EmailSender {
  sendMagicLink(email: MagicLinkEmail): Promise<void>;
  /**
   * Send the GDPR account-erasure confirmation (§5.14). Same swappable seam as
   * {@link sendMagicLink}: the in-memory fake records it, the Resend sender mails
   * it. Best-effort at the call site (the erasure has already committed), but a
   * real transport that fails still surfaces a typed error, never a silent hang.
   */
  sendAccountDeletion(email: AccountDeletionEmail): Promise<void>;
}

/** In-memory EmailSender for tests: records every "sent" message, sends nothing. */
export class InMemoryEmailSender implements EmailSender {
  readonly sent: MagicLinkEmail[] = [];
  readonly sentAccountDeletions: AccountDeletionEmail[] = [];

  async sendMagicLink(email: MagicLinkEmail): Promise<void> {
    this.sent.push(email);
  }

  async sendAccountDeletion(email: AccountDeletionEmail): Promise<void> {
    this.sentAccountDeletions.push(email);
  }

  /** Most recently "sent" link for an address, or undefined. */
  lastFor(to: string): MagicLinkEmail | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].to === to) return this.sent[i];
    }
    return undefined;
  }
}
