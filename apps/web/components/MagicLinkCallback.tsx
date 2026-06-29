"use client";

import { useEffect, useRef, useState } from "react";
import { AppApiError, type AppApiClient } from "../lib/appApiClient.ts";
import { authErrorMessage } from "../lib/authErrors.ts";

export interface MagicLinkCallbackProps {
  token: string | undefined;
  client: AppApiClient;
}

type State =
  | { phase: "verifying" }
  | { phase: "success" }
  | { phase: "error"; message: string };

/**
 * Magic-link CALLBACK page (SPEC §5.1). Reads `?token`, verifies it through the
 * injected client, and renders verifying → signed-in, or maps a typed
 * `SAMO-AUTH-00x` failure to its exact §5.16 copy. A missing token is treated as
 * an invalid link (SAMO-AUTH-001) without a network round-trip.
 */
export function MagicLinkCallback({ token, client }: MagicLinkCallbackProps) {
  const [state, setState] = useState<State>(() =>
    token
      ? { phase: "verifying" }
      : { phase: "error", message: authErrorMessage("SAMO-AUTH-001") },
  );

  // The magic-link token is SINGLE-USE: a second verify of the same token 401s
  // ("already used"). React StrictMode double-invokes effects in dev (setup →
  // cleanup → setup on the same instance, so this ref persists), which would
  // otherwise fire a second, racing verify. Guard so each token verifies once.
  const verifiedTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!token) return;
    if (verifiedTokenRef.current === token) return;
    verifiedTokenRef.current = token;
    client.verifyMagicLink(token).then(
      () => setState({ phase: "success" }),
      (err: unknown) => {
        const code = err instanceof AppApiError ? err.code : "";
        setState({ phase: "error", message: authErrorMessage(code) });
      },
    );
  }, [token, client]);

  if (state.phase === "verifying") {
    return (
      <section aria-live="polite">
        <h1>Signing you in</h1>
        <p>Verifying your sign-in link…</p>
      </section>
    );
  }

  if (state.phase === "success") {
    return (
      <section>
        <h1>You're signed in.</h1>
        <a href="/dashboard">Go to dashboard</a>
      </section>
    );
  }

  return (
    <section>
      <h1>Sign-in failed</h1>
      <p role="alert">{state.message}</p>
      <a href="/auth">Request a new link</a>
    </section>
  );
}
