"use client";

import { useEffect, useRef } from "react";

/** The one "main input" of the app: the dashboard's meeting-URL field. */
const MAIN_INPUT_SELECTOR = 'input[name="meetingUrl"]';
/** Any element that swallows plain keystrokes as text entry. */
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
/** A modal owns the keyboard while it is open (ModalFrame sets aria-modal). */
const OPEN_MODAL_SELECTOR = '[aria-modal="true"]';
/** How long a `g` prefix stays armed before it is forgotten. */
const CHORD_MS = 1000;

export interface ShortcutOptions {
  /** Called with an app path for `g d` / `g s`. */
  navigate: (path: string) => void;
  /** Called for `?`. */
  onHelp: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(EDITABLE_SELECTOR) !== null;
}

/**
 * Global keyboard shortcuts (SPEC-adjacent UX, Slice 6):
 * `/` focus the main input · `g d` dashboard · `g s` settings · `?` help.
 *
 * Deliberately inert while the user is typing in a field, while a modal
 * dialog is open, and for any Ctrl/Meta/Alt combination, so it never steals
 * a browser or OS shortcut.
 */
export function useShortcuts({ navigate, onHelp }: ShortcutOptions): void {
  const handlers = useRef({ navigate, onHelp });
  handlers.current = { navigate, onHelp };

  useEffect(() => {
    let armedAt = 0;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (document.querySelector(OPEN_MODAL_SELECTOR)) return;

      const now = Date.now();
      const armed = armedAt !== 0 && now - armedAt <= CHORD_MS;
      armedAt = 0;
      if (armed && (event.key === "d" || event.key === "s")) {
        event.preventDefault();
        handlers.current.navigate(event.key === "d" ? "/dashboard" : "/settings");
        return;
      }

      if (event.key === "g") {
        armedAt = now;
      } else if (event.key === "/") {
        event.preventDefault();
        document.querySelector<HTMLElement>(MAIN_INPUT_SELECTOR)?.focus();
      } else if (event.key === "?") {
        event.preventDefault();
        handlers.current.onHelp();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
