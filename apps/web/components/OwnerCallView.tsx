"use client";

import { useState } from "react";
import { PerCallTranscript } from "./PerCallTranscript.tsx";
import { ShareModal } from "./ShareModal.tsx";
import type { TranscriptStreamClient } from "../lib/transcriptStreamClient.ts";
import type { ShareApiClient } from "../lib/shareApiClient.ts";
import type { AppApiClient } from "../lib/appApiClient.ts";

export interface OwnerCallViewProps {
  streamClient: TranscriptStreamClient;
  shareClient: ShareApiClient;
  /** App-api client for the per-call Delete action (`DELETE /calls/:id`, §5.14). */
  appClient: AppApiClient;
  callId: string;
  /** The meeting URL, pre-filled on the dashboard if the owner hits "Try again" (Story 4). */
  meetingUrl: string;
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
 * dashboard with the original URL pre-filled, where the owner must explicitly
 * re-submit to create a new Call row (one user action = one Call row, §5.2).
 */
export function OwnerCallView({
  streamClient,
  shareClient,
  appClient,
  callId,
  meetingUrl,
  redirect,
}: OwnerCallViewProps) {
  const [shareOpen, setShareOpen] = useState(false);
  // Two-step delete (§5.14): the first click only ARMS a confirmation — the
  // DELETE is sent to app-api only after the owner explicitly confirms. `deleting`
  // guards against a double-submit while the request is in flight.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
    <>
      <PerCallTranscript
        streamClient={streamClient}
        auth={{ kind: "session" }}
        callId={callId}
        controls={({ view }) => (
          <div className="samograph-owner-controls">
            <button type="button" onClick={() => setShareOpen(true)}>
              Share
            </button>
            {view.showTryAgain ? (
              <button
                type="button"
                onClick={() =>
                  redirect(`/dashboard?url=${encodeURIComponent(meetingUrl)}`)
                }
              >
                Try again
              </button>
            ) : null}
            <button type="button" onClick={() => setConfirmingDelete(true)}>
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
            <p className="samograph-delete-error" role="alert">
              {deleteError}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setConfirmingDelete(false);
              setDeleteError(null);
            }}
            disabled={deleting}
          >
            Cancel
          </button>
          <button type="button" onClick={confirmDelete} disabled={deleting}>
            Confirm delete
          </button>
        </div>
      ) : null}
    </>
  );
}
