"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { AppApiError, type AppApiClient, type Call } from "../lib/appApiClient.ts";
import { validateMeetingUrl } from "../lib/validateMeetingUrl.ts";

export interface AddToCallFormProps {
  client: AppApiClient;
  /** Story-4 hook: pre-fill the paste input (e.g. after COULD_NOT_JOIN). */
  initialUrl?: string;
  /** Called after a successful create so the dashboard can refresh its list. */
  onCreated?: (call: Call) => void;
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
export function AddToCallForm({ client, initialUrl = "", onCreated }: AddToCallFormProps) {
  const inputId = useId();
  const urlRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [call, setCall] = useState<Call | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateMeetingUrl(urlRef.current?.value ?? "");
    if (!validation.ok) {
      setError(REJECT_MESSAGE);
      setPhase("error");
      return;
    }
    setError(null);
    setPhase("creating");
    try {
      const created = await client.createCall({ meetingUrl: validation.url });
      setCall(created);
      setPhase("created");
      onCreated?.(created);
    } catch (err) {
      // Surface the server's typed `{code,message}` (e.g. SAMO-CALL-URL) instead
      // of swallowing it behind a generic "Try again." (defect: typed errors).
      setError(err instanceof AppApiError ? err.message : GENERIC_ERROR);
      setPhase("error");
    }
  }

  return (
    <section>
      <h1>Add samograph to a call</h1>
      <form onSubmit={onSubmit} noValidate>
        <label htmlFor={inputId}>Meeting link</label>
        <input
          id={inputId}
          ref={urlRef}
          name="meetingUrl"
          type="text"
          defaultValue={initialUrl}
          autoComplete="off"
          placeholder="Paste a Zoom or Google Meet link"
        />
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" disabled={phase === "creating"}>
          Add to call
        </button>
      </form>
      {call ? (
        <p>
          Call {call.id} created — status: <strong>{call.status}</strong>
        </p>
      ) : null}
    </section>
  );
}
