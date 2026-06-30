"use client";

import { useState } from "react";
import { PerCallTranscript } from "./PerCallTranscript.tsx";
import { ShareModal } from "./ShareModal.tsx";
import type { TranscriptStreamClient } from "../lib/transcriptStreamClient.ts";
import type { ShareApiClient } from "../lib/shareApiClient.ts";

export interface OwnerCallViewProps {
  streamClient: TranscriptStreamClient;
  shareClient: ShareApiClient;
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
  callId,
  meetingUrl,
  redirect,
}: OwnerCallViewProps) {
  const [shareOpen, setShareOpen] = useState(false);

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
    </>
  );
}
