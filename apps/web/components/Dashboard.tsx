"use client";

import { useCallback, useEffect, useState } from "react";
import { AddToCallForm } from "./AddToCallForm.tsx";
import { PageHeader } from "./PageHeader.tsx";
import { AccountDangerZone } from "./AccountDangerZone.tsx";
import { UpcomingMeetings } from "./UpcomingMeetings.tsx";
import { AppApiError, type AppApiClient, type Call } from "../lib/appApiClient.ts";
import { statusView, type StatusView } from "../lib/callStatusView.ts";
import { displayMeetingUrl, meetingTitle } from "../lib/meetingUrl.ts";
import { relativeTime } from "../lib/relativeTime.ts";

export interface DashboardProps {
  client: AppApiClient;
  /** Navigate away (injected so the component is testable without next router). */
  redirect: (path: string) => void;
  /** Story-4 retry — the call whose meeting URL seeds the paste input, resolved from the API-loaded list so the FULL URL, Zoom passcode included, is restored. */
  retryCallId?: string;
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

/**
 * Accessible name for the whole-row link (screen readers get the intent).
 * `title` is the display-safe {@link meetingTitle}, never the raw URL: a Zoom
 * link carries its password in the query string and an `aria-label` is DOM text
 * like any other (mobile audit M7 / `d02`).
 */
function rowAriaLabel(title: string, view: StatusView, cta: RowCta | null): string {
  if (cta?.kind === "live") return `Live call ${title} — open to watch the live transcript`;
  if (cta?.kind === "open") return `${view.label} call ${title} — view transcript`;
  if (cta?.kind === "retry") return `${view.message} ${title} — open to try again`;
  return `${view.message} ${title} — open call`;
}

/**
 * Render one call as a whole-row transcript link: a readable TITLE, one META
 * line (status chip · relative time · display-safe URL) and the CTA.
 *
 * The row used to be the raw `meetingUrl` — which meant the Zoom `?pwd=` join
 * secret was printed in the list (mobile audit M7 / `d02`). Everything shown
 * here goes through `meetingTitle` / `displayMeetingUrl`, which drop the query
 * string and the fragment, so no meeting password can reach the DOM.
 */
function CallRow({ call, now }: { call: Call; now: number }) {
  // §5.16 view: for a terminal failure the message carries the persisted
  // status_reason ("Couldn't join — <reason>.") plus a bespoke, actionable hint.
  const view = statusView(call.status, { recallReason: call.statusReason });
  const cta = rowCta(view);
  const title = meetingTitle(call.meetingUrl);
  const safeUrl = displayMeetingUrl(call.meetingUrl);
  const createdAt = call.createdAt;
  const when = createdAt ? relativeTime(createdAt, now) : "";
  return (
    <li className="samograph-call-item">
      {/* The per-call page reads the meeting URL from `GET /calls/:id`, so no
          URL — safe or otherwise — travels through the address bar. */}
      <a
        className="samograph-call-row"
        data-status-kind={view.kind}
        href={`/calls/${encodeURIComponent(call.id)}`}
        aria-label={rowAriaLabel(title, view, cta)}
      >
        <span className="samograph-call-body">
          <span className="samograph-call-title">{title}</span>
          <span className="samograph-call-meta">
            <span className="samograph-status-chip" data-kind={view.kind}>
              {view.kind === "live" ? (
                <span className="samograph-call-live-dot" aria-hidden="true" />
              ) : null}
              {view.label}
            </span>
            {when && createdAt ? (
              <time
                className="samograph-call-time"
                dateTime={createdAt}
                title={new Date(createdAt).toLocaleString()}
              >
                {when}
              </time>
            ) : null}
            {safeUrl ? (
              <span className="samograph-call-url" title={safeUrl}>{safeUrl}</span>
            ) : null}
          </span>
          {view.kind === "error" ? (
            <>
              <span className="samograph-call-error">{view.message}</span>
              {view.hint ? <span className="samograph-call-hint">{view.hint}</span> : null}
            </>
          ) : null}
        </span>
        {cta ? (
          <span className={`samograph-call-cta samograph-call-cta-${cta.kind}`}>
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
export function Dashboard({ client, redirect, retryCallId }: DashboardProps) {
  const [status, setStatus] = useState<Status>("loading");
  const [calls, setCalls] = useState<Call[]>([]);
  const calendarAuthFailure = useCallback(() => {
    setStatus("redirecting");
    redirect("/auth");
  }, [redirect]);

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
  // One clock read per render, injected into every row, so the list's relative
  // times are consistent with each other and the helper stays pure.
  const now = Date.now();
  const active = calls.filter((c) => !statusView(c.status).isTerminal);
  const past = calls.filter((c) => statusView(c.status).isTerminal);
  const retryUrl = retryCallId
    ? calls.find((c) => c.id === retryCallId)?.meetingUrl ?? ""
    : "";

  return (
    <>
      <PageHeader
        title="Your calls"
        description="Every call samograph has joined, live and finished. Open one to watch or read its transcript."
      />
      <AddToCallForm client={client} initialUrl={retryUrl} autoFocus={calls.length === 0} onCreated={() => void load()} />
      <UpcomingMeetings client={client} onAuthFailure={calendarAuthFailure} onCreated={() => void load()} />
      {calls.length === 0 ? (
        <section aria-label="Your calls" className="samograph-empty-state">
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
            <section aria-label="Active calls" className="samograph-section">
              <div className="samograph-section-header">
                <h2 className="samograph-section-title">Active calls</h2>
              </div>
              <ul className="samograph-call-list">
                {active.map((c) => (
                  <CallRow key={c.id} call={c} now={now} />
                ))}
              </ul>
            </section>
          ) : null}
          {past.length > 0 ? (
            <section aria-label="Past calls" className="samograph-section">
              <div className="samograph-section-header">
                <h2 className="samograph-section-title">Past calls</h2>
              </div>
              <ul className="samograph-call-list">
                {past.map((c) => (
                  <CallRow key={c.id} call={c} now={now} />
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
