/**
 * Production EmailSender: sends the magic-link email through Resend's HTTP API
 * (SPEC §5.1 — same swappable interface as the in-memory fake; nothing else in
 * the auth flow changes).
 *
 *   POST https://api.resend.com/emails
 *   Authorization: Bearer <RESEND_API_KEY>
 *   { from, to, subject, html }
 *
 * The fetch transport is injected so tests assert the exact request with no
 * network and no real key. Failures are TYPED (`ResendEmailError`) and bounded
 * by a timeout — never a silent hang. The API key is never logged and is
 * redacted from any error text the provider echoes back.
 */
import type { EmailSender, MagicLinkEmail, AccountDeletionEmail } from "./email.ts";

export const RESEND_EMAILS_URL = "https://api.resend.com/emails";
export const MAGIC_LINK_SUBJECT = "Sign in to samograph.dev";
export const ACCOUNT_DELETED_SUBJECT = "Your samograph.dev account has been deleted";
/** Bound every send; a stuck transport must fail typed, not hang the request. */
export const RESEND_TIMEOUT_MS = 10_000;

/** Typed failure for any Resend send problem (HTTP error, network, timeout). */
export class ResendEmailError extends Error {
  override readonly name = "ResendEmailError";
  /** HTTP status from Resend, or undefined for transport-level failures. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface ResendEmailSenderOptions {
  /** Resend API key (secret — never logged, redacted from errors). */
  apiKey: string;
  /** Verified sender, e.g. `SamoGraph <signin@samograph.dev>` (MAGIC_LINK_FROM). */
  from: string;
  /** Injected transport for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Send timeout; defaults to {@link RESEND_TIMEOUT_MS}. */
  timeoutMs?: number;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Minimal, self-contained sign-in email; the link is the only dynamic part. */
function magicLinkHtml(link: string): string {
  const href = escapeHtml(link);
  return (
    `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">` +
    `<h2 style="margin:0 0 12px">Sign in to samograph.dev</h2>` +
    `<p>Click the button below to sign in. This link is single-use and expires in 15 minutes.</p>` +
    `<p style="margin:24px 0"><a href="${href}" ` +
    `style="background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">` +
    `Sign in</a></p>` +
    `<p style="color:#666;font-size:13px">If the button doesn't work, copy this URL into your browser:<br>` +
    `<a href="${href}">${href}</a></p>` +
    `<p style="color:#666;font-size:13px">If you didn't request this, you can ignore this email.</p>` +
    `</div>`
  );
}

/** Minimal, self-contained account-deletion confirmation (no link/token). */
function accountDeletedHtml(): string {
  return (
    `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">` +
    `<h2 style="margin:0 0 12px">Your samograph.dev account has been deleted</h2>` +
    `<p>Your account and all of its data — calls, transcripts, share links and ` +
    `recordings — have been permanently erased, and any active recordings deleted ` +
    `at our recording provider.</p>` +
    `<p style="color:#666;font-size:13px">If you didn't request this, contact us right away.</p>` +
    `</div>`
  );
}

export class ResendEmailSender implements EmailSender {
  readonly #apiKey: string;
  readonly #from: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: ResendEmailSenderOptions) {
    this.#apiKey = opts.apiKey;
    this.#from = opts.from;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? RESEND_TIMEOUT_MS;
  }

  /** Strip the secret from any text that might surface in errors/logs. */
  #redact(text: string): string {
    return text.split(this.#apiKey).join("[REDACTED]");
  }

  async sendMagicLink(email: MagicLinkEmail): Promise<void> {
    let res: Response;
    try {
      res = await this.#fetch(RESEND_EMAILS_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: this.#from,
          to: email.to,
          subject: MAGIC_LINK_SUBJECT,
          html: magicLinkHtml(email.link),
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ResendEmailError(
        `Resend request failed before a response: ${this.#redact(detail)}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ResendEmailError(
        `Resend rejected the magic-link email (HTTP ${res.status}): ` +
          this.#redact(body.slice(0, 500)),
        res.status,
      );
    }
  }

  async sendAccountDeletion(email: AccountDeletionEmail): Promise<void> {
    let res: Response;
    try {
      res = await this.#fetch(RESEND_EMAILS_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: this.#from,
          to: email.to,
          subject: ACCOUNT_DELETED_SUBJECT,
          html: accountDeletedHtml(),
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ResendEmailError(
        `Resend request failed before a response: ${this.#redact(detail)}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ResendEmailError(
        `Resend rejected the account-deletion email (HTTP ${res.status}): ` +
          this.#redact(body.slice(0, 500)),
        res.status,
      );
    }
  }
}

/**
 * Env-driven selection: the REAL Resend sender when RESEND_API_KEY is set,
 * otherwise the provided fallback (dev/in-memory fake) — so local runs and
 * tests keep working with no key. A key without MAGIC_LINK_FROM is a
 * misconfiguration and fails fast at startup.
 */
export function emailSenderFromEnv(
  env: Record<string, string | undefined>,
  fallback: EmailSender,
): EmailSender {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return fallback;
  const from = env.MAGIC_LINK_FROM;
  if (!from) {
    throw new Error(
      "RESEND_API_KEY is set but MAGIC_LINK_FROM is missing — set MAGIC_LINK_FROM to a Resend-verified sender address",
    );
  }
  return new ResendEmailSender({ apiKey, from });
}
