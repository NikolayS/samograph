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

/**
 * The one-time "a Google account was attached to your samograph.dev account"
 * notice (issue #209 / SPEC amendment S5-1 item 5).
 *
 * Linking a Google `sub` to an EXISTING magic-link account is deliberately
 * SILENT — there is no confirmation step — so this email is the counterweight:
 * with no session revocation anywhere in this system (sign-out is a cookie
 * clear; a session is a 30-day stateless HMAC), it is the ONLY mechanism by
 * which a successful takeover on that branch would ever be noticed. It is sent
 * on the link-to-existing branch ONLY: never for a brand-new account (nothing to
 * warn about), never on a returning sign-in (it would become noise nobody
 * reads, which is the same as not sending it at all).
 */
export interface IdentityLinkedEmail {
  to: string;
  /** The provider that was attached. `"google"` is the only v1 member. */
  provider: "google";
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
  /**
   * Send the {@link IdentityLinkedEmail} security notice. Same swappable seam as
   * the other two. Best-effort at the call site — the sign-in has already
   * succeeded and must not be undone by a mail outage — but a real transport
   * that fails still surfaces a typed error to be logged, never a silent hang.
   */
  sendIdentityLinked(email: IdentityLinkedEmail): Promise<void>;
}

/** In-memory EmailSender for tests: records every "sent" message, sends nothing. */
export class InMemoryEmailSender implements EmailSender {
  readonly sent: MagicLinkEmail[] = [];
  readonly sentAccountDeletions: AccountDeletionEmail[] = [];
  readonly sentIdentityLinks: IdentityLinkedEmail[] = [];

  async sendMagicLink(email: MagicLinkEmail): Promise<void> {
    this.sent.push(email);
  }

  async sendAccountDeletion(email: AccountDeletionEmail): Promise<void> {
    this.sentAccountDeletions.push(email);
  }

  async sendIdentityLinked(email: IdentityLinkedEmail): Promise<void> {
    this.sentIdentityLinks.push(email);
  }

  /** Most recently "sent" link for an address, or undefined. */
  lastFor(to: string): MagicLinkEmail | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].to === to) return this.sent[i];
    }
    return undefined;
  }
}
