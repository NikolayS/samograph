"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { type AppApiClient, type Call } from "../lib/appApiClient.ts";
import { validateMeetingUrl } from "../lib/validateMeetingUrl.ts";

export interface AddToCallFormProps {
  client: AppApiClient;
  /** Story-4 hook: pre-fill the paste input (e.g. after COULD_NOT_JOIN). */
  initialUrl?: string;
}

type Phase = "idle" | "creating" | "created" | "error";

const REJECT_MESSAGE = "Enter a Zoom or Google Meet link.";

/**
 * The dashboard shell's single primary action (SPEC §2, §3 Story 1): paste a
 * Zoom / Google Meet URL and "Add to call". Client-side URL-shape validation
 * runs before the (future) `/calls` POST; on success the returned call's
 * `PENDING` status is rendered.
 */
export function AddToCallForm({ client, initialUrl = "" }: AddToCallFormProps) {
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
    } catch {
      setError("Couldn't add samograph to that call. Try again.");
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
