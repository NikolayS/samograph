"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AppApiError, type AppApiClient, type Call } from "../lib/appApiClient.ts";
import { isSessionInvalid, SESSION_INVALID_MESSAGE } from "../lib/apiError.ts";
import { validateMeetingUrl } from "../lib/validateMeetingUrl.ts";

export interface AddToCallFormProps {
  client: AppApiClient;
  /** Story-4 hook: pre-fill the paste input (e.g. after COULD_NOT_JOIN). */
  initialUrl?: string;
  /** Called after a successful create so the dashboard can refresh its list. */
  onCreated?: (call: Call) => void;
  /** Focus the meeting-link input when this form is the dashboard's empty-state action. */
  autoFocus?: boolean;
}

type Phase = "idle" | "creating" | "created" | "error";

/**
 * Client-side reject copy, kept VERBATIM consistent with app-api's typed
 * `SAMO-CALL-URL` message (apps/app-api/calls/errors.ts) so the user sees the
 * same sentence whether the pre-flight check or the server rejects the URL.
 */
const REJECT_MESSAGE = "That doesn't look like a Zoom or Google Meet meeting link.";

/** Last-resort copy when a create fails with no typed server message. */
const GENERIC_ERROR = "Couldn't add samograph to that call. Try again.";

/**
 * The dashboard shell's single primary action (SPEC §2, §3 Story 1): paste a
 * Zoom / Google Meet URL and "Add to call". Client-side URL-shape validation
 * runs before the (future) `/calls` POST; on success the returned call's
 * `PENDING` status is rendered.
 */
export function AddToCallForm({ client, initialUrl = "", onCreated, autoFocus = false }: AddToCallFormProps) {
  const inputId = useId();
  const urlRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [call, setCall] = useState<Call | null>(null);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);

  useEffect(() => {
    if (autoFocus) urlRef.current?.focus();
  }, [autoFocus]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateMeetingUrl(urlRef.current?.value ?? "");
    if (!validation.ok) {
      setError(REJECT_MESSAGE);
      setPhase("error");
      return;
    }
    setError(null);
    setActiveCallId(null);
    setPhase("creating");
    try {
      const created = await client.createCall({ meetingUrl: validation.url });
      setCall(created);
      setPhase("created");
      onCreated?.(created);
    } catch (err) {
      if (err instanceof AppApiError && err.code === "SAMO-CALL-ACTIVE" && err.id) {
        setActiveCallId(err.id);
        setPhase("created");
        return;
      }
      // A stale/absent session (deleted tenant → SAMO-AUTH-005, or any 401) gets a
      // DISTINCT "you've been signed out" copy, not the generic failure (#114).
      if (isSessionInvalid(err)) {
        setError(SESSION_INVALID_MESSAGE);
        setPhase("error");
        return;
      }
      // Otherwise surface the server's typed `{code,message}` (e.g. SAMO-CALL-URL)
      // instead of swallowing it behind a generic "Try again." (defect: typed errors).
      setError(err instanceof AppApiError ? err.message : GENERIC_ERROR);
      setPhase("error");
    }
  }

  return (
    <section className="samograph-dash-hero">
      <h2>Add samograph to a call</h2>
      <form onSubmit={onSubmit} noValidate>
        <div className="samograph-dash-hero-form">
          <label htmlFor={inputId}>Meeting link</label>
          <input
            id={inputId}
            ref={urlRef}
            name="meetingUrl"
            type="text"
            defaultValue={initialUrl}
            autoComplete="off"
            placeholder="Paste a Zoom or Google Meet link"
            className="samograph-field-input--mono"
          />
          <button type="submit" className="samograph-btn samograph-btn--primary" disabled={phase === "creating"} aria-busy={phase === "creating"}>
            Add to call
          </button>
        </div>
        {error ? <p role="alert" className="samograph-alert samograph-alert--error">{error}</p> : null}
      </form>
      {call ? (
        <p>
          Call {call.id} created — status: <strong>{call.status}</strong>
        </p>
      ) : null}
      {activeCallId ? <p><a href={`/calls/${encodeURIComponent(activeCallId)}`}>samograph is already in this call</a></p> : null}
    </section>
  );
}
