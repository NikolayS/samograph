"use client";

import { useEffect, useRef, useState } from "react";
import type { AppApiClient } from "../lib/appApiClient.ts";

/**
 * The EXACT phrase the owner must type to arm the destructive account-delete
 * button (type-to-confirm). Case- and whitespace-sensitive so it cannot be
 * triggered by an accidental keypress or a stray click.
 */
export const ACCOUNT_DELETE_CONFIRM_PHRASE = "DELETE";

export interface AccountDangerZoneProps {
  client: AppApiClient;
  /** Navigate away after erasure (injected so the component is testable). */
  redirect: (path: string) => void;
}

/**
 * Account "Danger zone" (SPEC §5.14 GDPR). Permanently erases the WHOLE account —
 * every call, transcript, share link, and recording — via `DELETE /account`.
 *
 * This is irreversible, so it is gated behind TYPE-TO-CONFIRM: the delete button
 * stays disabled until the owner types {@link ACCOUNT_DELETE_CONFIRM_PHRASE}
 * exactly. On success the session is already dead (the server cleared the
 * cookie), so we navigate to the landing page; on failure we surface an error and
 * stay put so nothing is silently lost.
 *
 * The confirmation input is UNCONTROLLED and read through a native `ref`
 * listener — the same ref-read pattern the rest of the web package uses for text
 * inputs (React's synthetic onChange is unreliable under the test harness).
 */
export function AccountDangerZone({ client, redirect }: AccountDangerZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [armed, setArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const sync = () => setArmed(el.value === ACCOUNT_DELETE_CONFIRM_PHRASE);
    el.addEventListener("input", sync);
    el.addEventListener("change", sync);
    return () => {
      el.removeEventListener("input", sync);
      el.removeEventListener("change", sync);
    };
  }, []);

  async function onDelete() {
    setDeleting(true);
    setError(null);
    try {
      await client.deleteAccount();
      // The account and its session are gone — leave the now-dead app.
      redirect("/");
    } catch {
      setDeleting(false);
      setError("Couldn't delete your account. Please try again.");
    }
  }

  return (
    <section
      className="samograph-danger-zone"
      aria-labelledby="samograph-danger-zone-title"
    >
      <h2 id="samograph-danger-zone-title">Danger zone</h2>
      <p>
        Permanently delete your account and everything in it — all calls, their
        transcripts, every share link, and the recordings (deleted at our
        recording provider too). This can&rsquo;t be undone.
      </p>
      <label className="samograph-danger-confirm">
        <span>
          Type <strong>{ACCOUNT_DELETE_CONFIRM_PHRASE}</strong> to confirm
        </span>
        <input
          type="text"
          ref={inputRef}
          defaultValue=""
          disabled={deleting}
          autoComplete="off"
          aria-label={`Type ${ACCOUNT_DELETE_CONFIRM_PHRASE} to confirm account deletion`}
        />
      </label>
      {error ? (
        <p className="samograph-danger-error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        className="samograph-danger-delete"
        onClick={onDelete}
        disabled={!armed || deleting}
      >
        Permanently delete account
      </button>
    </section>
  );
}
