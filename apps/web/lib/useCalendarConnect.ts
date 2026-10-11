"use client";

import { useCallback, useState } from "react";
import { AppApiError, type AppApiClient } from "./appApiClient.ts";
import { authErrorMessage, isAuthErrorCode } from "./authErrors.ts";

interface UseCalendarConnectOptions {
  client: AppApiClient;
  onAuthFailure: () => void;
  navigate: (authorizationUrl: string) => void;
}

export function useCalendarConnect({ client, onAuthFailure, navigate }: UseCalendarConnectOptions) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clearError = useCallback(() => setError(null), []);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await client.startCalendarConnect();
      let authorizationUrl: URL;
      try {
        authorizationUrl = new URL(result.authorizationUrl);
      } catch {
        setError(authErrorMessage("SAMO-CALENDAR-500"));
        return;
      }
      if (authorizationUrl.protocol !== "https:" || authorizationUrl.hostname !== "accounts.google.com") {
        setError(authErrorMessage("SAMO-CALENDAR-500"));
        return;
      }
      navigate(result.authorizationUrl);
    } catch (caught) {
      if (caught instanceof AppApiError && caught.status === 401) {
        onAuthFailure();
        return;
      }
      setError(caught instanceof AppApiError && isAuthErrorCode(caught.code)
        ? authErrorMessage(caught.code)
        : "Google Calendar couldn’t be connected. Please try again.");
    } finally {
      setBusy(false);
    }
  }, [client, navigate, onAuthFailure]);

  return { busy, error, connect, clearError };
}
