"use client";

import { useState } from "react";
import type { AppApiClient } from "../lib/appApiClient.ts";

export interface LogoutButtonProps {
  client: AppApiClient;
  /** Navigate to the sign-in page (injected so this is testable without next router). */
  redirect: (path: string) => void;
}

/**
 * Signed-in header control (SPEC §5.1). Clicking it POSTs `/auth/logout` to clear
 * the session cookie, then sends the user to the sign-in page.
 *
 * The redirect is BEST-EFFORT: it runs even if the clear request fails, so a
 * transient server error never traps the user on a signed-in surface (the stale
 * cookie still expires on its own TTL, and app-api re-checks it on every request).
 */
export function LogoutButton({ client, redirect }: LogoutButtonProps) {
  const [busy, setBusy] = useState(false);

  async function onLogout() {
    setBusy(true);
    try {
      await client.logout();
    } catch {
      // Best-effort: swallow the failure and still send the user to sign-in.
    } finally {
      redirect("/auth");
    }
  }

  return (
    <button type="button" onClick={() => void onLogout()} disabled={busy}>
      {busy ? "Logging out…" : "Log out"}
    </button>
  );
}
