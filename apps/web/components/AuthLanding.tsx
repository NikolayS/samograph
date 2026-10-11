"use client";

import { useEffect, useState } from "react";
import { MagicLinkRequestForm } from "./MagicLinkRequestForm.tsx";
import { GoogleSignInButton } from "./GoogleSignInButton.tsx";
import { authErrorMessage, isAuthInfoCode } from "../lib/authErrors.ts";
import type { AppApiClient } from "../lib/appApiClient.ts";

export interface AuthLandingProps {
  client: AppApiClient;
  /** Navigate away (injected so the component is testable without next router). */
  redirect: (path: string) => void;
  /**
   * `?error=<CODE>` from the URL (issue #209). The Google callback is a browser
   * redirect and so cannot return a JSON body; it hands the §5.16 code back on
   * the query string instead. Untrusted input — rendered only through the
   * code→copy map, never echoed.
   */
  errorCode?: string;
}

/**
 * Sign-in page wrapper (SPEC §5.1). Renders the page heading, then the available
 * credentials — "Continue with Google" (issue #209) above the magic-link form —
 * but if the visitor already has a valid session (a `GET /calls` probe succeeds)
 * it sends them on to the dashboard instead of asking them to sign in again
 * (defect: signed-in users on /auth should land on the dashboard). Anonymous
 * visitors (401) simply see the form.
 *
 * The Google button renders ONLY when `GET /auth/providers` reports
 * `{google:true}`. That probe never rejects — any failure resolves to
 * `{google:false}` — so the worst case is "magic link only", never a broken page
 * and never a button that dead-ends at Google. Branch previews are exactly this
 * case by design: they get no Google credentials, so they get no button. Magic
 * link is always present, so Google is never the only way in.
 */
export function AuthLanding({ client, redirect, errorCode }: AuthLandingProps) {
  // `null` = probe not settled. Distinct from `false` so the button never flashes
  // in and out on a slow or failing probe.
  const [google, setGoogle] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    client.listCalls().then(
      () => {
        if (active) redirect("/dashboard"); // already signed in
      },
      () => {
        // 401 (or any probe failure): stay on the sign-in form.
      },
    );
    return () => {
      active = false;
    };
  }, [client, redirect]);

  useEffect(() => {
    let active = true;
    // Contractually cannot reject; the `.then` has one arm on purpose.
    client.authProviders().then((providers) => {
      if (active) setGoogle(providers.google);
    });
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <div className="samograph-auth">
      <p className="samograph-app-brand" data-wordmark>samograph</p>
      <h1>Sign in to samograph</h1>
      {errorCode !== undefined ? (
        isAuthInfoCode(errorCode) ? (
          // "You cancelled" is a normal outcome, not a failure (§5.16 S5-1).
          <p role="status" className="samograph-auth-note samograph-alert samograph-alert--info">
            {authErrorMessage(errorCode)}
          </p>
        ) : (
          <p role="alert" className="samograph-alert samograph-alert--error">{authErrorMessage(errorCode)}</p>
        )
      ) : null}
      {google === true ? (
        <>
          <GoogleSignInButton />
          {/* Decorative: the button and the form each announce themselves, so
              the connective "or" would only add noise to a screen reader. */}
          <div className="samograph-auth-divider" aria-hidden="true">
            or
          </div>
        </>
      ) : null}
      <MagicLinkRequestForm client={client} />
    </div>
  );
}
