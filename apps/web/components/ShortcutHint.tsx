"use client";

import { useId } from "react";
import { ModalFrame } from "./ModalFrame.tsx";

export function ShortcutHint({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  return (
    <ModalFrame titleId={titleId} onClose={onClose}>
      <header className="samograph-modal-header">
        <h2 id={titleId}>Keyboard shortcuts</h2>
        <button type="button" className="samograph-btn samograph-btn--ghost" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <dl className="samograph-shortcut-list">
        <div><dt><kbd>/</kbd></dt><dd>Focus meeting URL</dd></div>
        <div><dt><kbd>g</kbd> <kbd>d</kbd></dt><dd>Dashboard</dd></div>
        <div><dt><kbd>g</kbd> <kbd>s</kbd></dt><dd>Settings</dd></div>
        <div><dt><kbd>?</kbd></dt><dd>This help</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Close</dd></div>
      </dl>
    </ModalFrame>
  );
}
