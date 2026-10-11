"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import type { AppApiClient } from "../lib/appApiClient.ts";

export interface MagicLinkRequestFormProps {
  client: AppApiClient;
}

type Phase = "idle" | "sending" | "sent" | "error";

/**
 * Magic-link REQUEST page (SPEC §5.1, §10 #7).
 *
 * Collects an email and POSTs it to `/auth/magic-link`, then shows the
 * check-your-email state. That state is NOT a dead end: it offers a "didn't get
 * it?" resend + an alternate-email path (SPEC §10 #7 launch blocker). In DEV the
 * in-memory email fake exposes the link at `GET /__dev/last-magic-link`; we
 * surface it inline so local testing can proceed without a real inbox (the probe
 * returns `null` in production, so nothing dev-only ever renders there).
 *
 * HEADINGS: this component owns NO `<h1>`. `AuthLanding` does (issue #209) — the
 * page heading has to sit above BOTH credential options, and two components each
 * owning an `<h1>` is precisely how a page ends up with two. The
 * check-your-email heading is therefore an `<h2>` beneath that `<h1>`.
 */
export function MagicLinkRequestForm({ client }: MagicLinkRequestFormProps) {
  const emailId = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState("");
  const [devLink, setDevLink] = useState<string | null>(null);
  const [resending, setResending] = useState(false);

  async function send(email: string): Promise<boolean> {
    await client.requestMagicLink({ email });
    setSentTo(email);
    setDevLink(await client.lastDevMagicLink(email));
    return true;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = (emailRef.current?.value ?? "").trim();
    if (trimmed === "") {
      setError("Enter your email address.");
      setPhase("error");
      return;
    }
    setError(null);
    setPhase("sending");
    try {
      await send(trimmed);
      setPhase("sent");
    } catch {
      setError("Couldn't send the link. Try again.");
      setPhase("error");
    }
  }

  async function onResend() {
    setResending(true);
    setDevLink(null);
    try {
      await send(sentTo);
    } catch {
      // Stay on the check-your-email screen; the user can try again or switch.
    } finally {
      setResending(false);
    }
  }

  function onUseDifferentEmail() {
    setPhase("idle");
    setError(null);
    setSentTo("");
    setDevLink(null);
  }

  if (phase === "sent") {
    return (
      <section aria-live="polite" className="samograph-auth-sent">
        <h2>Check your email</h2>
        <div className="samograph-auth-sent-message">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 5h18v14H3V5Zm2 2v.5l7 5 7-5V7H5Zm14 10V10l-7 5-7-5v7h14Z" /></svg>
          <p role="status" className="samograph-alert samograph-alert--info">We sent a sign-in link to <span className="samograph-auth-email">{sentTo}</span>.</p>
        </div>
        <p>Didn&apos;t get it?</p>
        <div className="samograph-actions">
          <button type="button" className="samograph-btn samograph-btn--secondary" onClick={onResend} disabled={resending} aria-busy={resending}>
            Resend link
          </button>
          <button type="button" className="samograph-btn samograph-btn--secondary" onClick={onUseDifferentEmail}>
            Use a different email
          </button>
        </div>
        {devLink ? (
          <p>
            Dev only —{" "}
            <a href={devLink}>open your sign-in link</a>
          </p>
        ) : null}
      </section>
    );
  }

  return (
    // `samograph-auth-form` is the /auth geometry contract (mobile audit M8):
    // the email field, this submit and "Continue with Google" are one 44px
    // full-width stack rather than three sizes in a 480px column.
    <form className="samograph-auth-form" onSubmit={onSubmit} noValidate>
      <label htmlFor={emailId}>Email</label>
      <input
        id={emailId}
        ref={emailRef}
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
      />
      {error ? <p role="alert" className="samograph-alert samograph-alert--error">{error}</p> : null}
      <button type="submit" className="samograph-btn samograph-btn--primary" disabled={phase === "sending"} aria-busy={phase === "sending"}>
        Send magic link
      </button>
    </form>
  );
}
