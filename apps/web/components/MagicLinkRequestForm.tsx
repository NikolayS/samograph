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
      <section aria-live="polite">
        <h1>Check your email</h1>
        <p>We sent a sign-in link to {sentTo}.</p>
        <p>Didn&apos;t get it?</p>
        <button type="button" onClick={onResend} disabled={resending}>
          Resend link
        </button>
        <button type="button" onClick={onUseDifferentEmail}>
          Use a different email
        </button>
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
    <form onSubmit={onSubmit} noValidate>
      <h1>Sign in to samograph</h1>
      <label htmlFor={emailId}>Email</label>
      <input
        id={emailId}
        ref={emailRef}
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
      />
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={phase === "sending"}>
        Send magic link
      </button>
    </form>
  );
}
