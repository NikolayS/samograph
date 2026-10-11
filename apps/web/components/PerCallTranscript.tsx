"use client";

import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import {
  formatRenderLine,
  formatTranscriptTimestamp,
  splitTranscriptTimestamp,
  initialTranscriptState,
  isTerminalStatus,
  SAMOGRAPH_WARNING_SPEAKER,
  transcriptReducer,
} from "../lib/transcriptView.ts";
import { statusView, type StatusView } from "../lib/callStatusView.ts";
import { AppApiError } from "../lib/appApiClient.ts";
import {
  transcriptDownloadHref,
  type CallRef,
  type StreamAuth,
  type StreamHandle,
  type TranscriptStreamClient,
  type TranscriptStreamEvent,
} from "../lib/transcriptStreamClient.ts";
import { DegradedBanner, WarningLine } from "./DegradedBanner.tsx";
import { displayMeetingUrl } from "../lib/meetingUrl.ts";

/**
 * §5.16 user-facing copy for the typed stream failures the read-only page can
 * hit. Exported so views/tests assert the exact string from one source.
 */
export const SHARE_INACTIVE_COPY = "This share/agent link is no longer active.";
export const RATE_LIMIT_COPY = "Too many connections/commands on this link.";

const STREAM_ERROR_COPY: Record<string, string> = {
  "SAMO-TOKEN-002": SHARE_INACTIVE_COPY,
  "SAMO-RATE-001": RATE_LIMIT_COPY,
  "SAMO-AUTHZ-001": "You don't have access to this call.",
};

/** Map a typed stream error to its §5.16 copy, falling back to the raw message. */
export function streamErrorCopy(code: string, fallback?: string): string {
  return (
    STREAM_ERROR_COPY[code] ??
    fallback ??
    "This transcript stream is unavailable right now."
  );
}

/** Context handed to the `controls` render-prop so owner affordances can react to status. */
export interface ControlsContext {
  view: StatusView;
}

export interface PerCallTranscriptProps {
  streamClient: TranscriptStreamClient;
  /** Owner session OR an anonymous share token (§5.7). */
  auth: StreamAuth;
  /** The call this view streams. For a share, the WS-hub resolves the call from the token. */
  callId: string;
  /** Owner-visible meeting URL. Omitted by the capability-token share view. */
  meetingUrl?: string;
  /** Recall failure reason surfaced in the `COULD_NOT_JOIN` copy (§5.16). */
  recallReason?: string;
  /**
   * Owner controls slot. Presentation-mode-agnostic: the read-only share page
   * omits it, which makes it provably control-free (Story 2). A render-prop so
   * controls (e.g. Try-again) can key off the live status (`view.showTryAgain`).
   */
  controls?: (ctx: ControlsContext) => ReactNode;
  /**
   * Status-poll fallback cadence (#106). Tests shrink it; production keeps the
   * default. `0`/negative disables the poll (WS-only).
   */
  statusPollIntervalMs?: number;
}

/** Default cadence of the status-poll fallback (#106): ~4.5s while non-terminal. */
export const STATUS_POLL_INTERVAL_MS = 4_500;

/**
 * Per-call live read-along (SPEC §2, §4.1, §5.2, §5.4, §5.5, §5.10, Stories
 * 1/2/5). Subscribes to `/calls/:id/stream` ONLY through the injected
 * stream-client seam (testable against the in-memory fake, no ws-hub), feeds the
 * pure `transcriptReducer`, and renders the status header (`statusView`), the
 * `DegradedBanner`, the live transcript (finalized lines + the trailing partial),
 * and the optional owner `controls`.
 *
 * Liveness: `connect()` on mount; on a server-initiated `gap` it backfills the
 * missing range via REST; on a benign close it reconnects with `sinceSeq` = the
 * last seen seq (§5.5 replay); a terminal status closes the stream; a typed
 * `SAMO-…` failure (from `fetchCallDetail` or a fatal close) shows a never-silent
 * terminal card (§5.16) instead of an empty hang.
 *
 * Status-poll fallback (#106): the app-api status poller publishes status flips
 * via pg_notify, but no process runs LISTEN (Bun SQL has none), so cross-process
 * the WS `status` frame never arrives. While the call is non-terminal the page
 * re-polls `GET /calls/:id` (the same source it seeds from, share token and all)
 * every `statusPollIntervalMs` and applies the status/degraded/reason it returns;
 * a terminal status — from the stream OR the poll — stops the poll and closes
 * the stream. WS `status` handling stays (still live single-process).
 */
export function PerCallTranscript({
  streamClient,
  auth,
  callId,
  meetingUrl,
  recallReason,
  controls,
  statusPollIntervalMs = STATUS_POLL_INTERVAL_MS,
}: PerCallTranscriptProps) {
  const [state, dispatch] = useReducer(transcriptReducer, undefined, () =>
    initialTranscriptState(),
  );
  const [fatalError, setFatalError] = useState<AppApiError | null>(null);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const [isChatHidden, setIsChatHidden] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const transcriptRef = useRef<HTMLOListElement | null>(null);
  // §5.16 error detail (`calls.status_reason`) from the /calls/:id header —
  // stream frames never carry it, so the REST fetch is its only source.
  const [fetchedReason, setFetchedReason] = useState<string | undefined>(undefined);

  // Latest props read inside the long-lived effect without re-subscribing on
  // every render (callers pass `auth` inline, so its identity churns).
  const authRef = useRef<StreamAuth>(auth);
  authRef.current = auth;
  const callIdRef = useRef(callId);
  callIdRef.current = callId;
  // Latest committed state, read by the async seed so it never dispatches a
  // redundant update (which would re-render — and warn — for no visible change).
  const stateRef = useRef(state);
  stateRef.current = state;

  // Stable identity of the subscription target — the effect re-runs only when
  // the call or the auth *content* changes, not on every parent re-render.
  const authKey = auth.kind === "share" ? `share:${auth.token}` : "session";

  useEffect(() => {
    const handleRef: { current: StreamHandle | null } = { current: null };
    let lastSeq: number | undefined;
    let streamEventArrived = false;
    let dead = false;
    let cancelled = false;
    // Reconnect backoff: 0 ⇒ the first drop resumes immediately (snappy); each
    // further drop with no intervening downstream traffic backs off, so a
    // persistently-closing socket can't busy-loop. Reset by any real frame.
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const makeRef = (): CallRef => ({
      callId: callIdRef.current,
      auth: authRef.current,
    });

    const fail = (err: AppApiError) => {
      if (cancelled) return;
      dead = true;
      handleRef.current?.close();
      stopPoll();
      setFatalError(err);
    };

    // #106 status-poll fallback: no server process runs LISTEN, so the status
    // poller's pg_notify never becomes a cross-process WS `status` frame. While
    // non-terminal, re-poll /calls/:id (same auth as the mount seed, so a share
    // token rides along) and apply what the server says; stop once terminal.
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const stopPoll = () => {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    const pollTick = async () => {
      if (cancelled || dead || isTerminalStatus(stateRef.current.status)) {
        stopPoll();
        return;
      }
      try {
        const d = await streamClient.fetchCallDetail(makeRef());
        if (cancelled || dead) return;
        if (d.statusReason) setFetchedReason(d.statusReason);
        if (stateRef.current.status !== d.status) {
          dispatch({ type: "status", status: d.status });
        }
        if (d.degraded !== stateRef.current.degraded) {
          dispatch({ type: "degraded", degraded: d.degraded });
        }
        if (isTerminalStatus(d.status)) {
          // Call is over — same teardown as a terminal stream frame.
          dead = true;
          handleRef.current?.close();
          stopPoll();
        }
      } catch {
        // The poll is a fallback — a transient failure must not kill the page;
        // the next tick retries. Fatal typed errors surface via the mount fetch
        // or a stream close, which own the §5.16 card.
      }
    };
    if (statusPollIntervalMs > 0) {
      pollTimer = setInterval(() => void pollTick(), statusPollIntervalMs);
    }

    const open = () => {
      handleRef.current = streamClient.connect(
        { callId: callIdRef.current, auth: authRef.current, sinceSeq: lastSeq },
        onEvent,
      );
    };

    const runBackfill = async (sinceSeq: number) => {
      try {
        const lines = await streamClient.backfill(makeRef(), sinceSeq);
        if (cancelled || dead) return;
        dispatch({ type: "backfill", lines });
        for (const l of lines) {
          if (lastSeq === undefined || l.seq > lastSeq) lastSeq = l.seq;
        }
      } catch (err) {
        if (err instanceof AppApiError) fail(err);
      }
    };

    const scheduleReconnect = () => {
      const run = () => {
        if (cancelled || dead) return;
        handleRef.current?.close();
        open();
      };
      const delay =
        reconnectAttempts === 0
          ? 0
          : Math.min(500 * 2 ** (reconnectAttempts - 1), 10_000);
      reconnectAttempts += 1;
      // The first reconnect is deferred to a microtask (never re-enter the fake's
      // synchronous delivery loop); later ones use a backing-off timer.
      if (delay === 0) queueMicrotask(run);
      else reconnectTimer = setTimeout(run, delay);
    };

    const onEvent = (event: TranscriptStreamEvent) => {
      if (cancelled) return;
      // Real downstream traffic means the connection works — reset the backoff so
      // the next genuine drop resumes immediately. (`open`/`closed` don't count.)
      if (event.type !== "open" && event.type !== "closed") reconnectAttempts = 0;
      switch (event.type) {
        case "open":
          streamEventArrived = true;
          dispatch(event);
          break;
        case "line":
          streamEventArrived = true;
          // A partial is not safely replayed past: reconnecting with its seq as
          // the cursor can make the server omit the finalized replacement.
          if (event.final && (lastSeq === undefined || event.seq > lastSeq)) {
            lastSeq = event.seq;
          }
          dispatch(event);
          break;
        case "status":
          streamEventArrived = true;
          dispatch(event);
          if (isTerminalStatus(event.status)) {
            // Call is over — tear the stream down (the terminal card renders from state).
            dead = true;
            handleRef.current?.close();
            stopPoll();
          }
          break;
        case "degraded":
          streamEventArrived = true;
          dispatch(event);
          break;
        case "gap":
          streamEventArrived = true;
          dispatch(event);
          void runBackfill(event.sinceSeq);
          break;
        case "closed": {
          dispatch(event);
          const code =
            event.reason && event.reason.startsWith("SAMO-") ? event.reason : undefined;
          if (code) {
            // A revoke/rate close carries its SAMO code — never reconnect, show the card.
            fail(new AppApiError(code, streamErrorCopy(code), false, event.code));
          } else if (!dead) {
            scheduleReconnect();
          }
          break;
        }
        default:
          break;
      }
    };

    // Seed status + degraded from the call header without clobbering anything the
    // live stream already delivered (the stream is authoritative once it speaks).
    streamClient
      .fetchCallDetail(makeRef())
      .then((d) => {
        if (cancelled) return;
        // The persisted §5.16 reason applies even when the stream spoke first
        // (a terminal `status` frame carries no reason of its own).
        if (d.statusReason) setFetchedReason(d.statusReason);
        if (dead || streamEventArrived) return;
        if (stateRef.current.status !== d.status) {
          dispatch({ type: "status", status: d.status });
        }
        if (d.degraded && !stateRef.current.degraded) {
          dispatch({ type: "degraded", degraded: true });
        }
      })
      .catch((err) => {
        if (err instanceof AppApiError) fail(err);
      });

    open();

    return () => {
      cancelled = true;
      dead = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopPoll();
      handleRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps — auth read via ref; key gates re-subscribe.
  }, [streamClient, callId, authKey, statusPollIntervalMs]);

  // An explicit prop wins; otherwise the reason fetched from /calls/:id applies.
  const view = statusView(state.status, { recallReason: recallReason ?? fetchedReason });
  const hasLines = state.lines.length > 0 || state.partial !== null;
  // The header shows the meeting link at every width, so it is the query-stripped
  // form: a Zoom `?pwd=` is a join secret and must never be rendered ("" when the
  // URL cannot be parsed, which renders nothing at all).
  const shownMeetingUrl = meetingUrl ? displayMeetingUrl(meetingUrl) : "";
  const emptyCopy = view.kind === "pending"
    ? "Waiting for the bot to join…"
    : view.kind === "joining"
      ? "Joining the meeting…"
      : view.kind === "live"
        ? "Connected — waiting for the first words."
        : view.isTerminal
          ? "No transcript was captured."
          : null;

  useEffect(() => {
    if (view.kind !== "live") return;
    const timer = setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1_000);
    return () => clearInterval(timer);
  }, [view.kind]);

  useEffect(() => {
    if (!isPinnedToBottom) return;
    const transcript = transcriptRef.current;
    transcript?.scrollTo?.({ top: transcript.scrollHeight });
  }, [state.lines.length, state.partial?.text, isPinnedToBottom, isChatHidden]);

  // A terminal failure with nothing captured replaces the empty list with the
  // failure card; once lines exist the transcript stays and the header keeps
  // the copy, so §5.16 is never dropped.
  const statusMessageMovedToCard = !fatalError && !hasLines && view.kind === "error";

  const jumpToLive = () => {
    const transcript = transcriptRef.current;
    transcript?.scrollTo?.({ top: transcript.scrollHeight, behavior: "smooth" });
    setIsPinnedToBottom(true);
  };

  return (
    <section aria-live="polite" aria-label="Live transcript" className="samograph-percall samograph-instrument">
      <header className="samograph-status samograph-instrument-head" data-status-kind={view.kind}>
        <div className="samograph-instrument-meta">
          {auth.kind === "session" ? <strong>call / {callId.slice(0, 8)}</strong> : <strong>shared transcript</strong>}
          {auth.kind === "session" && shownMeetingUrl ? <><i aria-hidden="true">|</i><span className="samograph-instrument-url">{shownMeetingUrl}</span></> : null}
          {auth.kind === "session" ? <><i aria-hidden="true">|</i><span className="samograph-instrument-dictionary">dictionary: account default</span></> : null}
        </div>
        <div className="samograph-instrument-state">
          <span className="samograph-status-label">{view.label}</span>
          <span className="samograph-status-elapsed" aria-hidden="true">
            {formatElapsed(elapsedSeconds)}
          </span>
        </div>
        {/* The error card below carries this copy only when it stands in for an
            empty transcript; otherwise the header keeps it (§5.16). */}
        {statusMessageMovedToCard ? null : <p className="samograph-status-message">{view.message}</p>}
        {view.code ? <small className="samograph-status-code">{view.code}</small> : null}
      </header>

      <DegradedBanner degraded={state.degraded} />

      {fatalError || statusMessageMovedToCard ? (
        <div role="alert" className="samograph-stream-error samograph-alert samograph-alert--error">
          <p>{fatalError ? streamErrorCopy(fatalError.code, fatalError.message) : view.message}</p>
        </div>
      ) : (
        <ol
          ref={transcriptRef}
          className="samograph-transcript samograph-instrument-lines"
          aria-label="Transcript"
          onScroll={(event) => {
            const el = event.currentTarget;
            setIsPinnedToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          }}
        >
          {!hasLines && emptyCopy && view.kind !== "error" ? <li className="samograph-transcript-empty">{emptyCopy}</li> : null}
          {state.lines.filter((l) => !isChatHidden || l.kind !== "chat").map((l) =>
            l.speaker === SAMOGRAPH_WARNING_SPEAKER ? (
              <li key={l.seq} className="samograph-warning-row">
                <WarningLine line={l} />
              </li>
            ) : (
              <li key={l.seq} className="samograph-line samograph-transcript-row">
                <span className="samograph-visually-hidden">{formatRenderLine(l)}</span>
                <span className="samograph-line-number" aria-hidden="true">{l.seq}</span>
                <TranscriptTime ts={l.ts} />
                <b
                  className="samograph-line-speaker"
                  aria-hidden="true"
                  data-speaker-index={speakerIndex(l.speaker)}
                  title={`${l.speaker}${l.kind === "chat" ? " (chat)" : ""}`}
                >
                  <span className="samograph-line-speaker-name">{l.speaker}</span>
                  <span className="samograph-line-speaker-marker">{l.kind === "chat" ? " (chat):" : ":"}</span>
                </b>
                <span className="samograph-line-utterance" aria-hidden="true">{l.text}</span>
              </li>
            ),
          )}
          {state.partial ? (
            <li
              key={`partial-${state.partial.seq}`}
              className="samograph-line samograph-line-partial samograph-transcript-row"
              aria-busy="true"
            >
              <span className="samograph-visually-hidden">{formatRenderLine(state.partial)}</span>
              <span className="samograph-line-number" aria-hidden="true">{state.partial.seq}</span>
              <TranscriptTime ts={state.partial.ts} />
              <b
                className="samograph-line-speaker"
                aria-hidden="true"
                data-speaker-index={speakerIndex(state.partial.speaker)}
                title={`${state.partial.speaker}${state.partial.kind === "chat" ? " (chat)" : ""}`}
              >
                <span className="samograph-line-speaker-name">{state.partial.speaker}</span>
                <span className="samograph-line-speaker-marker">{state.partial.kind === "chat" ? " (chat):" : ":"}</span>
              </b>
              <span className="samograph-line-utterance" aria-hidden="true">{state.partial.text}</span>
            </li>
          ) : null}
        </ol>
      )}

      {!isPinnedToBottom && hasLines ? <button type="button" className="samograph-jump-live" aria-label="Jump to live" onClick={jumpToLive}>Jump to live</button> : null}

      <footer className="samograph-controls samograph-instrument-foot">
        <div className="samograph-transcript-actions">
          <a className="samograph-download-transcript" href={transcriptDownloadHref(callId, auth)} download>Download transcript</a>
          <a className="samograph-download-transcript-speech" href={transcriptDownloadHref(callId, auth, { excludeComments: true })} download>Download (no chat)</a>
          <button
            type="button"
            className="samograph-toggle-chat"
            aria-pressed={isChatHidden}
            onClick={() => setIsChatHidden((hidden) => !hidden)}
          >
            Hide chat
          </button>
        </div>
        <div className="samograph-share-state">
          <span>{auth.kind === "share" ? "Read-only shared link" : "Share link · owner controls"}</span>
          {controls ? controls({ view }) : null}
        </div>
      </footer>
    </section>
  );
}

/**
 * The row timestamp, split so the date half can be dropped below the 1024px reflow
 * breakpoint (it repeats on every row); the full value stays in `title`/`dateTime`.
 */
function TranscriptTime({ ts }: { ts: string }) {
  const formatted = formatTranscriptTimestamp(ts);
  const parts = splitTranscriptTimestamp(formatted);
  return (
    <time className="samograph-line-time" aria-hidden="true" dateTime={formatted} title={formatted}>
      {parts ? (
        <>
          <span className="samograph-line-date">{parts.date}</span>
          <span className="samograph-line-clock">{parts.clock}</span>
        </>
      ) : (
        formatted
      )}
    </time>
  );
}

function speakerIndex(speaker: string): number {
  let hash = 0;
  for (const char of speaker) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 6;
}

function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}
