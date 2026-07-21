"use client";

import { useCallback, useEffect, useState } from "react";
import { AddToCallForm } from "./AddToCallForm.tsx";
import { LogoutButton } from "./LogoutButton.tsx";
import { AccountDangerZone } from "./AccountDangerZone.tsx";
import { AppApiError, type AppApiClient, type Call } from "../lib/appApiClient.ts";
import { statusView, type StatusView } from "../lib/callStatusView.ts";

export interface DashboardProps {
  client: AppApiClient;
  /** Navigate away (injected so the component is testable without next router). */
  redirect: (path: string) => void;
  /** Story-4 pre-fill: seed the paste input (e.g. after a COULD_NOT_JOIN "Try again"). */
  initialUrl?: string;
}

type Status = "loading" | "ready" | "redirecting";

/**
 * Dashboard-only affordance model for a call row (presentation, not data).
 * Every row is a whole-row link into its per-call transcript page; this decides
 * the *explicit* call-to-action so a first-time user knows the row is tappable:
 *  - `live`  → prominent pulsing "● Live — watch transcript" (open it NOW)
 *  - `open`  → "View transcript →" (pending / joining / ended)
 *  - `retry` → "Try again →" for COULD_NOT_JOIN (the per-call page owns Try again)
 *  - `null`  → other terminal failures keep only their reason — a failed row is
 *             never dressed up as a transcript invite.
 */
type RowCta = { kind: "live" | "open" | "retry"; text: string };

function rowCta(view: StatusView): RowCta | null {
  if (view.kind === "live") return { kind: "live", text: "Live — watch transcript" };
  if (view.kind === "ended" || view.kind === "pending" || view.kind === "joining") {
    return { kind: "open", text: "View transcript" };
  }
  if (view.status === "COULD_NOT_JOIN") return { kind: "retry", text: "Try again" };
  return null; // COULD_NOT_RECORD, BOT_REMOVED — reason only.
}

/** Accessible name for the whole-row link (screen readers get the intent). */
function rowAriaLabel(url: string, view: StatusView, cta: RowCta | null): string {
  if (cta?.kind === "live") return `Live call ${url} — open to watch the live transcript`;
  if (cta?.kind === "open") return `${view.label} call ${url} — view transcript`;
  if (cta?.kind === "retry") return `${view.message} ${url} — open to try again`;
  return `${view.message} ${url} — open call`;
}

/** Render one call as a whole-row transcript link with its status/error copy. */
function CallRow({ call }: { call: Call }) {
  // §5.16 view: for a terminal failure the message carries the persisted
  // status_reason ("Couldn't join — <reason>.") plus a bespoke, actionable hint.
  const view = statusView(call.status, { recallReason: call.statusReason });
  const cta = rowCta(view);
  return (
    <li className="samograph-call-item">
      {/* Whole-row link into the per-call transcript page; ?url= lets that page's
          Story-4 "Try again" (COULD_NOT_JOIN) pre-fill the paste input. The
          explicit CTA below makes the row read as an obvious, tappable way in. */}
      <a
        className="samograph-call-row"
        data-status-kind={view.kind}
        href={`/calls/${encodeURIComponent(call.id)}?url=${encodeURIComponent(call.meetingUrl)}`}
        aria-label={rowAriaLabel(call.meetingUrl, view, cta)}
      >
        <span className="samograph-call-body">
          <span className="samograph-call-url">{call.meetingUrl}</span>
          {view.kind === "error" ? (
            <>
              <span className="samograph-call-error">{view.message}</span>
              {view.hint ? (
                <span className="samograph-call-hint">{view.hint}</span>
              ) : null}
            </>
          ) : view.kind === "live" ? null : (
            <span className="samograph-call-status">{view.label}</span>
          )}
        </span>
        {cta ? (
          <span className={`samograph-call-cta samograph-call-cta-${cta.kind}`}>
            {cta.kind === "live" ? (
              <span className="samograph-call-live-dot" aria-hidden="true" />
            ) : null}
            <span className="samograph-call-cta-text">{cta.text}</span>
            {cta.kind === "live" ? null : (
              <span className="samograph-call-cta-arrow" aria-hidden="true">
                →
              </span>
            )}
          </span>
        ) : null}
      </a>
    </li>
  );
}

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
      <section aria-live="polite" aria-busy="true">
        <p role="status">Loading your dashboard…</p>
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

  // Split into two clearly-labelled groups: still-running calls the user might
  // want to open live vs. finished/failed ones. Terminal = ENDED plus every
  // COULD_NOT_* / BOT_REMOVED failure (`isTerminalStatus`, SPEC §5.2).
  const active = calls.filter((c) => !statusView(c.status).isTerminal);
  const past = calls.filter((c) => statusView(c.status).isTerminal);

  return (
    <>
      <header>
        <LogoutButton client={client} redirect={redirect} />
      </header>
      <AddToCallForm client={client} initialUrl={initialUrl} onCreated={() => void load()} />
      {calls.length === 0 ? (
        <section aria-label="Your calls" className="samograph-empty-state">
          <h2>Your calls</h2>
          <p className="samograph-empty-title">No calls yet.</p>
          <p>Paste a Zoom or Google Meet link above to add samograph to your first call.</p>
          <p className="samograph-empty-hint">
            samograph joins the meeting and streams a live transcript you can watch,
            share read-only, and download.
          </p>
        </section>
      ) : (
        <>
          {active.length > 0 ? (
            <section aria-label="Active calls">
              <h2>Active calls</h2>
              <ul className="samograph-call-list">
                {active.map((c) => (
                  <CallRow key={c.id} call={c} />
                ))}
              </ul>
            </section>
          ) : null}
          {past.length > 0 ? (
            <section aria-label="Past calls">
              <h2>Past calls</h2>
              <ul className="samograph-call-list">
                {past.map((c) => (
                  <CallRow key={c.id} call={c} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
      {/* §5.14 GDPR: permanent whole-account erasure, gated by type-to-confirm. */}
      <AccountDangerZone client={client} redirect={redirect} />
    </>
  );
}
