"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/** Intentionally non-modal because this confirmation renders inline within its parent card. */
export function InlineConfirm({ title, children, confirmLabel, busy = false, onCancel, onConfirm }: {
  title: string; children: ReactNode; confirmLabel: string; busy?: boolean;
  onCancel: () => void; onConfirm: () => void;
}) {
  const titleId = useId();
  const firstButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { firstButton.current?.focus(); }, []);
  return (
    <div
      className="samograph-confirm"
      role="dialog"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <h3 id={titleId}>{title}</h3>
      <p>{children}</p>
      <div className="samograph-actions">
        <button ref={firstButton} type="button" className="samograph-btn samograph-btn--secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="samograph-btn samograph-btn--danger samograph-btn--solid" onClick={onConfirm} disabled={busy} aria-busy={busy}>{confirmLabel}</button>
      </div>
    </div>
  );
}
