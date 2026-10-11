"use client";

import { useEffect, useId, useState } from "react";
import {
  AppApiError,
  type ShareApiClient,
  type ShareLink,
} from "../lib/shareApiClient.ts";
import { ModalFrame } from "./ModalFrame.tsx";

export interface ShareModalProps {
  shareClient: ShareApiClient;
  callId: string;
  onClose: () => void;
}

type Phase = "loading" | "empty" | "active";

/** Last-resort copy when a share action fails with no typed server message. */
const GENERIC_ERROR = "Something went wrong with the share link. Try again.";

/**
 * Owner Share control (SPEC §4.1 `/calls/:id/share`, §5.7 `share` scope, Story
 * 2). Talks to app-api only through the injected `ShareApiClient` seam, so it is
 * testable against the in-memory fake with no token-service.
 *
 * On open it reads the current share (`getShare`): none → "Create share link"
 * (`mintShare`); existing → the `/c/<token>` URL with Copy / Rotate / Revoke.
 * Rotate issues a new token and warns that the old one stopped working; Revoke
 * returns to the empty state (≤ 1 s revoke SLO is the server's job — this just
 * stops surfacing the link). Failures surface the typed `AppApiError` in a
 * `role="alert"`, never a silent no-op.
 */
export function ShareModal({ shareClient, callId, onClose }: ShareModalProps) {
  const titleId = useId();
  const [phase, setPhase] = useState<Phase>("loading");
  const [link, setLink] = useState<ShareLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rotated, setRotated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const existing = await shareClient.getShare(callId);
        if (cancelled) return;
        if (existing && existing.active) {
          setLink(existing);
          setPhase("active");
        } else {
          setPhase("empty");
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof AppApiError ? err.message : GENERIC_ERROR);
        setPhase("empty");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shareClient, callId]);

  function showLink(next: ShareLink, didRotate: boolean) {
    setLink(next);
    setPhase("active");
    setRotated(didRotate);
    setCopied(false);
    setError(null);
  }

  function fail(err: unknown) {
    setError(err instanceof AppApiError ? err.message : GENERIC_ERROR);
  }

  async function onCreate() {
    setBusy(true);
    setError(null);
    try {
      showLink(await shareClient.mintShare(callId), false);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function onRotate() {
    setBusy(true);
    setError(null);
    try {
      showLink(await shareClient.rotateShare(callId), true);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke() {
    setBusy(true);
    setError(null);
    try {
      await shareClient.revokeShare(callId);
      setLink(null);
      setRotated(false);
      setCopied(false);
      setPhase("empty");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    if (!link) return;
    try {
      const clip = navigator.clipboard;
      if (clip && typeof clip.writeText === "function") {
        await clip.writeText(link.url);
        setCopied(true);
      } else {
        // Clipboard API unavailable (insecure context / older browser): the URL
        // stays visible so the owner can select-and-copy it by hand.
        setError("Select the link above to copy it.");
      }
    } catch {
      setError("Couldn't copy automatically — select the link above to copy it.");
    }
  }

  return (
    <ModalFrame titleId={titleId} onClose={onClose}>
      <div className="samograph-share-modal">
        <header className="samograph-share-header">
          <h2 id={titleId}>Share read-only link</h2>
          <button type="button" className="samograph-btn samograph-btn--ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <p className="samograph-share-blurb">
          Anyone with this link can watch the live transcript read-only — they can't
          control the bot, mint tokens, or see your other calls.
        </p>

        {error ? <p role="alert" className="samograph-alert samograph-alert--error">{error}</p> : null}

        {phase === "loading" ? <p>Loading share status…</p> : null}

        {phase === "empty" ? (
          <button type="button" className="samograph-btn samograph-btn--primary" onClick={() => void onCreate()} disabled={busy} aria-busy={busy}>
            Create share link
          </button>
        ) : null}

        {phase === "active" && link ? (
          <div className="samograph-share-active">
            <a href={link.url} className="samograph-share-url">
              {link.url}
            </a>
            {rotated ? (
              <p className="samograph-share-rotated">
                The previous link stopped working.
              </p>
            ) : null}
            <div className="samograph-share-actions">
              <button type="button" className="samograph-btn samograph-btn--secondary" onClick={() => void onCopy()}>
                Copy link
              </button>
              {copied ? <span role="status">Copied</span> : null}
              <button type="button" className="samograph-btn samograph-btn--secondary" onClick={() => void onRotate()} disabled={busy} aria-busy={busy}>
                Rotate
              </button>
              <button type="button" className="samograph-btn samograph-btn--secondary" onClick={() => void onRevoke()} disabled={busy} aria-busy={busy}>
                Revoke
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </ModalFrame>
  );
}
