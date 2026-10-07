"use client";

import { useCallback, useEffect, useRef } from "react";

export const SNAPSHOT_REFRESH_INTERVAL_MS = 15_000;

/** Refresh cached app lists, with one request in flight per effect lifetime.
 * Loaders check isCurrent after awaiting before updating state or navigating.
 * Returning false stops refreshes (for example when the session has expired).
 */
export function useSnapshotRefresh(load: (isCurrent: () => boolean) => Promise<boolean | void>, enabled = true) {
  const trigger = useRef<((queue: boolean) => void) | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let inFlight = false;
    let queued = false;
    const isCurrent = () => active;
    const refresh = async (queue = false) => {
      if (!active) return;
      if (inFlight) { if (queue) queued = true; return; }
      inFlight = true;
      try {
        if (await load(isCurrent) === false) active = false;
      } finally {
        inFlight = false;
        if (queued && active) { queued = false; void refresh(); }
      }
    };
    trigger.current = (queue) => { void refresh(queue); };
    const foreground = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    const timer = setInterval(foreground, SNAPSHOT_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    void refresh();
    return () => {
      active = false;
      trigger.current = null;
      clearInterval(timer);
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [load, enabled]);
  // A mutation requests one follow-up if the current fetch predates it.
  return useCallback(() => trigger.current?.(true), []);
}
