"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { InlineConfirm } from "./InlineConfirm.tsx";
import { AppApiError, type AppApiClient, type CalendarStatus } from "../lib/appApiClient.ts";
import { authErrorMessage, isAuthErrorCode } from "../lib/authErrors.ts";
import { formatDateTime, type DateTimeFormatOptions } from "../lib/formatDateTime.ts";
import { useCalendarConnect } from "../lib/useCalendarConnect.ts";

type CalendarConnectionCardProps = DateTimeFormatOptions & { client: AppApiClient; onAuthFailure: () => void; nested?: boolean };

export function CalendarConnectionCard({ client, onAuthFailure, locale, timeZone, nested = false }: CalendarConnectionCardProps) {
  const initialParams = new URLSearchParams(window.location.search);
  const initialCalendarError = initialParams.get("calendar_error");
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [disconnectBusy, setDisconnectBusy] = useState(false);
  const [autoJoinBusy, setAutoJoinBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(() => initialCalendarError
    ? authErrorMessage(initialCalendarError)
    : initialParams.get("calendar") === "connected" ? "Google Calendar connected." : null);
  const [messageKind, setMessageKind] = useState<"error" | "success">(initialCalendarError ? "error" : "success");
  const [confirming, setConfirming] = useState(false);
  const disconnectTrigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const restoreFocusAfterDisconnect = useRef(false);
  const { busy: connectBusy, error: connectError, connect, clearError: clearConnectError } = useCalendarConnect({
    client,
    onAuthFailure,
    navigate: (authorizationUrl) => window.location.assign(authorizationUrl),
  });
  const busy = connectBusy || disconnectBusy || autoJoinBusy;

  const handleError = useCallback((error: unknown, fallback: string) => {
    if (error instanceof AppApiError && error.status === 401) { onAuthFailure(); return; }
    setMessageKind("error");
    setMessage(error instanceof AppApiError && isAuthErrorCode(error.code) ? authErrorMessage(error.code) : fallback);
  }, [onAuthFailure]);

  const load = useCallback(async () => {
    try { setStatus(await client.getCalendarStatus()); clearConnectError(); }
    catch (error) { handleError(error, "Couldn’t load Google Calendar. Try again."); }
  }, [client, clearConnectError, handleError]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("calendar_error") || params.has("calendar")) {
      params.delete("calendar_error"); params.delete("calendar");
      const query = params.toString();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    }
  }, []);
  useEffect(() => {
    if (!confirming && restoreFocusAfterDisconnect.current) {
      restoreFocusAfterDisconnect.current = false;
      (disconnectTrigger.current ?? card.current)?.focus();
    }
  }, [confirming]);

  async function disconnect() {
    setDisconnectBusy(true); setMessage(null); clearConnectError();
    try {
      await client.disconnectCalendar();
      await load();
      restoreFocusAfterDisconnect.current = true;
      setConfirming(false);
    }
    catch (error) { handleError(error, "Google Calendar couldn’t be disconnected. Try again."); }
    finally { setDisconnectBusy(false); }
  }

  async function toggleAutoJoin() {
    if (!status || status.state !== "connected") return;
    const previous = status.autoJoin === true, next = !previous;
    setStatus({ ...status, autoJoin: next }); setAutoJoinBusy(true); setMessage(null);
    try { setStatus(await client.updateCalendarAutoJoin(next)); }
    catch (error) {
      setStatus((current) => current ? { ...current, autoJoin: previous } : current);
      handleError(error, "Auto-record couldn’t be updated. Try again.");
    } finally { setAutoJoinBusy(false); }
  }

  function closeConfirm() {
    setConfirming(false);
    disconnectTrigger.current?.focus();
  }

  return <div ref={card} tabIndex={-1} role={nested ? undefined : "region"} aria-label={nested ? undefined : "Google Calendar"} className="samograph-calendar-card">
    <h2>Google Calendar</h2>
    {connectError || message ? (() => {
      const failure = Boolean(connectError) || messageKind === "error";
      const copy = connectError ?? message;
      return <p role={failure ? "alert" : "status"} className={`samograph-alert samograph-alert--${failure ? "error" : "success"}`}>{copy}</p>;
    })() : null}
    {!status ? <p aria-busy="true">Loading Google Calendar…</p> : status.state === "not_connected" ? <>
      <p>Show upcoming meetings from your calendar.</p>
      <div className="samograph-actions">
        <button type="button" className="samograph-btn samograph-btn--secondary" disabled={busy} aria-busy={connectBusy} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect Google Calendar"}</button>
      </div>
    </> : status.state === "broken" ? <>
      <p>Google Calendar needs to be reconnected.</p>
      <div className="samograph-actions">
        <button type="button" className="samograph-btn samograph-btn--secondary" disabled={busy} aria-busy={connectBusy} onClick={() => void connect()}>Reconnect</button>
        <button ref={disconnectTrigger} type="button" className="samograph-btn samograph-btn--danger" disabled={busy} onClick={() => setConfirming(true)}>Disconnect</button>
      </div>
    </> : <>
      <p><strong>Connected</strong></p>
      {status.lastSyncAt ? <p className="samograph-field-hint">Last synced {formatDateTime(status.lastSyncAt, { locale, timeZone })}</p> : null}
      <label className="samograph-toggle"><input type="checkbox" role="switch" checked={status.autoJoin === true} disabled={busy} onChange={() => void toggleAutoJoin()} /> <span><strong>Auto-record my meetings</strong><small className="samograph-field-hint">samograph joins every upcoming meeting with a video link a few minutes before it starts</small></span></label>
      <div className="samograph-actions">
        <button ref={disconnectTrigger} type="button" className="samograph-btn samograph-btn--danger" disabled={busy} onClick={() => setConfirming(true)}>Disconnect</button>
      </div>
    </>}
    {confirming ? <InlineConfirm title="Disconnect Google Calendar?" confirmLabel="Disconnect" busy={disconnectBusy} onCancel={closeConfirm} onConfirm={() => void disconnect()}>Upcoming meetings will be removed.</InlineConfirm> : null}
  </div>;
}
