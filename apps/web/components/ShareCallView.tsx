"use client";

import { PerCallTranscript } from "./PerCallTranscript.tsx";
import type { TranscriptStreamClient } from "../lib/transcriptStreamClient.ts";

/** Read-only page header (SPEC §5.7 — the share page hides all owner controls). */
export const SHARE_HEADER_COPY = "Read-only shared transcript — samograph.dev";

export interface ShareCallViewProps {
  streamClient: TranscriptStreamClient;
  /** The opaque `/c/<token>` capability token (§5.7). */
  shareToken: string;
}

/**
 * Read-only shared transcript page (SPEC §4.1, §5.7, Stories 2 & 6). Renders the
 * SAME `PerCallTranscript` as the owner page but with NO `controls` slot, so it
 * is provably control-free: there is no Share, no Try-again, nothing that could
 * leave the call, mint a token, or reveal other calls.
 *
 * The viewer authenticates with the share token only — no session/cookie. The
 * WS-hub resolves the call from the token (§5.6/§5.7), so the token is passed as
 * both the connect credential and the path key the seam expects; the path id is
 * advisory for a share connection.
 *
 * A typed `SAMO-TOKEN-002` (revoke/expiry) or `SAMO-RATE-001` (cap hit) surfaces
 * inside `PerCallTranscript` as a never-silent terminal card (§5.16), so a
 * revoked link shows "no longer active" within ≤ 1 s rather than hanging empty.
 */
export function ShareCallView({ streamClient, shareToken }: ShareCallViewProps) {
  return (
    <section className="samograph-share-page" aria-label="Shared transcript">
      <header className="samograph-share-page-header">
        <h1>{SHARE_HEADER_COPY}</h1>
        {/* Story 6: viewers see the same in-call recording disclosure the bot posts. */}
        <p className="samograph-share-disclosure">
          The samograph bot disclosed in-call that it is recording this call's
          audio for the host's live transcript. This is a read-only view.
        </p>
      </header>
      <PerCallTranscript
        streamClient={streamClient}
        auth={{ kind: "share", token: shareToken }}
        callId={shareToken}
      />
    </section>
  );
}
