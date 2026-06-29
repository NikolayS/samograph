"use client";

import { useEffect } from "react";
import { MagicLinkRequestForm } from "./MagicLinkRequestForm.tsx";
import type { AppApiClient } from "../lib/appApiClient.ts";

export interface AuthLandingProps {
  client: AppApiClient;
  /** Navigate away (injected so the component is testable without next router). */
  redirect: (path: string) => void;
}

/**
 * Sign-in page wrapper (SPEC §5.1). Renders the magic-link request form, but if
 * the visitor already has a valid session (a `GET /calls` probe succeeds) it
 * sends them on to the dashboard instead of asking them to sign in again
 * (defect: signed-in users on /auth should land on the dashboard). Anonymous
 * visitors (401) simply see the form.
 */
export function AuthLanding({ client, redirect }: AuthLandingProps) {
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

  return <MagicLinkRequestForm client={client} />;
}
