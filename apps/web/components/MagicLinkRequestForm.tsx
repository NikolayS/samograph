"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import type { AppApiClient } from "../lib/appApiClient.ts";

export interface MagicLinkRequestFormProps {
  client: AppApiClient;
}

type Phase = "idle" | "sending" | "sent" | "error";

/**
 * Magic-link REQUEST page (SPEC §5.1). Collects an email and POSTs it to
 * `/auth/magic-link` through the injected client, then shows the
 * check-your-email state. No real email is sent here — the backend is #42.
 */
export function MagicLinkRequestForm({ client }: MagicLinkRequestFormProps) {
  const emailId = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState("");

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
      await client.requestMagicLink({ email: trimmed });
      setSentTo(trimmed);
      setPhase("sent");
    } catch {
      setError("Couldn't send the link. Try again.");
      setPhase("error");
    }
  }

  if (phase === "sent") {
    return (
      <section aria-live="polite">
        <h1>Check your email</h1>
        <p>We sent a sign-in link to {sentTo}.</p>
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
