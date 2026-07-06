"use client";

import { useCallback, useEffect, useState } from "react";
import { AddToCallForm } from "./AddToCallForm.tsx";
import { LogoutButton } from "./LogoutButton.tsx";
import { AppApiError, type AppApiClient, type Call } from "../lib/appApiClient.ts";

export interface DashboardProps {
  client: AppApiClient;
  /** Navigate away (injected so the component is testable without next router). */
  redirect: (path: string) => void;
  /** Story-4 pre-fill: seed the paste input (e.g. after a COULD_NOT_JOIN "Try again"). */
  initialUrl?: string;
}

type Status = "loading" | "ready" | "redirecting";

/**
 * Dashboard shell (SPEC §3 Story 1). On load it fetches the tenant's calls via
 * `GET /calls` and renders them, so the list persists across reload (the create
 * action only *adds* to a server-backed list, it is not the source of truth).
 *
 * Auth gate (defect): an anonymous visitor's `GET /calls` 401s — we redirect to
 * the sign-in page instead of rendering an empty, broken dashboard. The API
 * already enforces 401, so this is UX, not a security boundary.
 */
export function Dashboard({ client, redirect, initialUrl }: DashboardProps) {
  const [status, setStatus] = useState<Status>("loading");
  const [calls, setCalls] = useState<Call[]>([]);

  const load = useCallback(async () => {
    try {
      const list = await client.listCalls();
      setCalls(list);
      setStatus("ready");
    } catch (err) {
      if (err instanceof AppApiError && err.status === 401) {
        setStatus("redirecting");
        redirect("/auth");
        return;
      }
      // Non-auth failure: don't trap the user — show the form with an empty list.
      setCalls([]);
      setStatus("ready");
    }
  }, [client, redirect]);

  useEffect(() => {
    void load();
  }, [load]);

  if (status === "loading") {
    return (
      <section aria-live="polite">
        <p>Loading your dashboard…</p>
      </section>
    );
  }

  if (status === "redirecting") {
    return (
      <section aria-live="polite">
        <p>Redirecting to sign in…</p>
      </section>
    );
  }

  return (
    <>
      <header>
        <LogoutButton client={client} redirect={redirect} />
      </header>
      <AddToCallForm client={client} initialUrl={initialUrl} onCreated={() => void load()} />
      <section aria-label="Your calls">
        <h2>Your calls</h2>
        {calls.length === 0 ? (
          <p>No calls yet. Paste a meeting link above to add samograph.</p>
        ) : (
          <ul>
            {calls.map((c) => (
              <li key={c.id}>
                <span>{c.meetingUrl}</span> — <strong>{c.status}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
