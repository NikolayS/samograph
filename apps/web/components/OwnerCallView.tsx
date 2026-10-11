"use client";

import { useEffect, useState } from "react";
import { PerCallTranscript } from "./PerCallTranscript.tsx";
import { ShareModal } from "./ShareModal.tsx";
import { PageHeader } from "./PageHeader.tsx";
import type { TranscriptStreamClient } from "../lib/transcriptStreamClient.ts";
import type { ShareApiClient } from "../lib/shareApiClient.ts";
import type { AppApiClient } from "../lib/appApiClient.ts";
import { displayMeetingUrl, meetingTitle } from "../lib/meetingUrl.ts";
import { safeExternalUrl } from "../lib/safeExternalUrl.ts";

export interface OwnerCallViewProps {
  streamClient: TranscriptStreamClient;
  shareClient: ShareApiClient;
  /** App-api client for owner reads and the per-call Delete action. */
  appClient: AppApiClient;
  callId: string;
  /** Navigate away (injected so the view is testable without the next router). */
  redirect: (path: string) => void;
}

/**
 * Owner per-call page (SPEC §4.1, Stories 1/2/4). Composes the presentation-mode-
 * agnostic `PerCallTranscript` with owner-only controls injected through its
 * `controls` slot: a Share button (opens `ShareModal`) and a Story-4 "Try again".
 *
 * Try-again is shown ONLY when the status view says so (`showTryAgain`, i.e.
 * `COULD_NOT_JOIN`, §5.16). It does NOT retry implicitly: it returns to the
 * dashboard with the call id; the dashboard resolves its full meeting URL from
 * the API-loaded owner list before pre-filling it. Thus a Zoom passcode remains
 * usable without ever entering the address bar or browser history (#286).
 */
export function OwnerCallView({
  streamClient,
  shareClient,
  appClient,
  callId,
  redirect,
}: OwnerCallViewProps) {
  const [shareOpen, setShareOpen] = useState(false);
  const [meetingUrl, setMeetingUrl] = useState("");
  // Two-step delete (§5.14): the first click only ARMS a confirmation — the
  // DELETE is sent to app-api only after the owner explicitly confirms. `deleting`
  // guards against a double-submit while the request is in flight.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    appClient.getCall(callId).then((call) => {
      if (!cancelled) setMeetingUrl(call.meetingUrl);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [appClient, callId]);

  // `meetingTitle` yields the constant "Meeting" and `displayMeetingUrl` "" for
  // an input they cannot parse (they never echo raw text, so a secret cannot
  // slip through). Neither is a usable heading — the call id still wins.
  const derivedTitle = meetingTitle(meetingUrl);
  const title =
    derivedTitle === "" || derivedTitle === "Meeting"
      ? `Call ${callId.slice(0, 8)}`
      : derivedTitle;
  const shownUrl = displayMeetingUrl(meetingUrl);

  async function confirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await appClient.deleteCall(callId);
      // The call and all of its data are gone — leave the now-dead page.
      redirect("/dashboard");
    } catch {
      // Keep the confirmation open so the owner can retry or cancel.
      setDeleting(false);
      setDeleteError("Couldn't delete this call. Please try again.");
    }
  }

  return (
    <section className="samograph-call-view">
      {/* The shared PageHeader (DESIGN-MODEL §4) — the back link is its eyebrow
          and the meeting link its description. The H1 is the meeting NAME, not
          the raw join link: a 28px URL wrapped over two lines and pushed the
          transcript below the fold on a phone (mobile audit §1 D). The link
          below is demoted to a small line whose visible TEXT and tooltip are
          query-stripped — a Zoom `?pwd=` is a join secret and must never be on
          screen. Its `href` is deliberately the RAW url: the link has to
          actually join the meeting, and a password-protected Zoom room needs
          the query to do that.
          `samograph-call-view-heading` is kept so #283's compact measurements
          (gap, margin and the mobile H1 size) still apply on top of the shared
          rules. */}
      <PageHeader
        className="samograph-call-view-heading"
        eyebrow={<a href="/dashboard" className="samograph-call-back">← Dashboard</a>}
        title={title}
        description={
          shownUrl ? (
            <a
              className="samograph-call-view-url"
              href={safeExternalUrl(meetingUrl) ?? undefined}
              target="_blank"
              rel="noreferrer noopener"
              title={shownUrl}
            >
              {shownUrl}
            </a>
          ) : null
        }
      />
      <PerCallTranscript
        streamClient={streamClient}
        auth={{ kind: "session" }}
        callId={callId}
        meetingUrl={meetingUrl}
        controls={({ view }) => (
          <div className="samograph-owner-controls">
            <button type="button" className="samograph-btn samograph-btn--secondary" onClick={() => setShareOpen(true)}>
              Share
            </button>
            {view.showTryAgain ? (
              <button
                type="button"
                className="samograph-btn samograph-btn--secondary"
                onClick={() =>
                  redirect(`/dashboard?retry=${encodeURIComponent(callId)}`)
                }
              >
                Try again
              </button>
            ) : null}
            <button type="button" className="samograph-btn samograph-btn--danger" onClick={() => setConfirmingDelete(true)}>
              Delete
            </button>
          </div>
        )}
      />
      {shareOpen ? (
        <ShareModal
          shareClient={shareClient}
          callId={callId}
          onClose={() => setShareOpen(false)}
        />
      ) : null}
      {confirmingDelete ? (
        <div
          className="samograph-delete-confirm"
          role="dialog"
          aria-label="Delete this call"
        >
          <p>
            This permanently erases the call, its transcript, its share links, and
            its recording. This can&rsquo;t be undone.
          </p>
          {deleteError ? (
            <p className="samograph-delete-error samograph-alert samograph-alert--error" role="alert">
              {deleteError}
            </p>
          ) : null}
          <button
            type="button"
            className="samograph-btn samograph-btn--secondary"
            onClick={() => {
              setConfirmingDelete(false);
              setDeleteError(null);
            }}
            disabled={deleting}
          >
            Cancel
          </button>
          <button type="button" className="samograph-btn samograph-btn--danger samograph-btn--solid" onClick={confirmDelete} disabled={deleting} aria-busy={deleting}>
            Confirm delete
          </button>
        </div>
      ) : null}
    </section>
  );
}
