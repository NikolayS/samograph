"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  AppApiError,
  type AppApiClient,
  type SettingsOptions,
} from "../lib/appApiClient.ts";

export interface SettingsPageProps {
  client: AppApiClient;
  /** Navigate away (injected so the component is testable without next router). */
  redirect: (path: string) => void;
}

type Phase = "loading" | "ready" | "saving" | "redirecting";

/**
 * Greenroom Settings page (SPEC §5.12). Loads the tenant's hosted settings
 * (dictionary preset + custom keyterms, transcription language, chat chime) into
 * a form and PUTs the edited full document back. Auth-gated like the dashboard:
 * a 401 on load/save redirects to sign-in rather than rendering a broken form.
 *
 * Keyterms are edited as free text — one term per line — and split on save; the
 * server normalizes (trim/dedupe/cap) so the client stays deliberately thin.
 */
export function SettingsPage({ client, redirect }: SettingsPageProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [options, setOptions] = useState<SettingsOptions | null>(null);
  const [preset, setPreset] = useState("none");
  // Keyterms are an UNCONTROLLED textarea (ref + defaultValue), like the
  // dashboard's URL input: a controlled textarea does not receive edits under the
  // component-test DOM. `loadNonce` keys it so a reload reseeds the defaultValue.
  const keytermsRef = useRef<HTMLTextAreaElement>(null);
  const [initialKeyterms, setInitialKeyterms] = useState("");
  const [loadNonce, setLoadNonce] = useState(0);
  const [language, setLanguage] = useState("multi");
  const [chime, setChime] = useState("blip");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const presetId = useId();
  const keytermsId = useId();
  const languageId = useId();
  const chimeId = useId();

  const load = useCallback(async () => {
    try {
      const snap = await client.getSettings();
      setOptions(snap.options);
      setPreset(snap.settings.dictionaryPreset);
      setInitialKeyterms(snap.settings.keyterms.join("\n"));
      setLoadNonce((n) => n + 1);
      setLanguage(snap.settings.language);
      setChime(snap.settings.chime);
      setPhase("ready");
    } catch (err) {
      if (err instanceof AppApiError && err.status === 401) {
        setPhase("redirecting");
        redirect("/auth");
        return;
      }
      setError("Couldn't load your settings. Try again.");
      setPhase("ready");
    }
  }, [client, redirect]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    setError(null);
    setPhase("saving");
    // One keyterm per line; trim + drop blanks (the server does the canonical
    // normalization — dedupe, per-term + count caps).
    const keyterms = (keytermsRef.current?.value ?? "")
      .split(/\r?\n/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    try {
      await client.saveSettings({ dictionaryPreset: preset, keyterms, language, chime });
      setSaved(true);
      setPhase("ready");
    } catch (err) {
      if (err instanceof AppApiError && err.status === 401) {
        setPhase("redirecting");
        redirect("/auth");
        return;
      }
      setError(err instanceof AppApiError ? err.message : "Couldn't save your settings. Try again.");
      setPhase("ready");
    }
  }

  if (phase === "loading") {
    return (
      <section aria-live="polite" aria-busy="true">
        <p role="status">Loading your settings…</p>
      </section>
    );
  }

  if (phase === "redirecting") {
    return (
      <section aria-live="polite">
        <p>Redirecting to sign in…</p>
      </section>
    );
  }

  const presets = options?.presets ?? [preset];
  const languages = options?.languages ?? [{ code: language, label: language }];
  const chimes = options?.chimes ?? [chime];

  return (
    <section aria-label="Settings" className="samograph-settings">
      <h1>Settings</h1>
      <form onSubmit={onSubmit}>
        <div className="samograph-field">
          <label htmlFor={presetId}>Dictionary preset</label>
          <select id={presetId} value={preset} onChange={(e) => setPreset(e.target.value)}>
            {presets.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <p className="samograph-field-hint">
            A shipped keyterm list (e.g. PostgresFM). Your custom terms below are added on top.
          </p>
        </div>

        <div className="samograph-field">
          <label htmlFor={keytermsId}>Custom keyterms (one per line)</label>
          <textarea
            key={loadNonce}
            id={keytermsId}
            ref={keytermsRef}
            defaultValue={initialKeyterms}
            rows={6}
            placeholder="pg_stat_statements&#10;autovacuum"
          />
        </div>

        <div className="samograph-field">
          <label htmlFor={languageId}>Language</label>
          <select id={languageId} value={language} onChange={(e) => setLanguage(e.target.value)}>
            {languages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>

        <div className="samograph-field">
          <label htmlFor={chimeId}>Chat chime</label>
          <select id={chimeId} value={chime} onChange={(e) => setChime(e.target.value)}>
            {chimes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" disabled={phase === "saving"}>
          Save settings
        </button>
        {saved ? <p role="status">Settings saved.</p> : null}
      </form>
    </section>
  );
}
