"use client";

import { useEffect, useRef, type ReactNode } from "react";

const TABBABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export interface ModalFrameProps {
  /** id of the heading inside `children` that names this dialog. */
  titleId: string;
  onClose: () => void;
  children: ReactNode;
}

export function ModalFrame({ titleId, onClose, children }: ModalFrameProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    (dialog?.querySelector<HTMLElement>(TABBABLE) ?? dialog)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const tabbable = Array.from(dialog.querySelectorAll<HTMLElement>(TABBABLE));
      if (!tabbable.length) return;
      const first = tabbable[0];
      const last = tabbable[tabbable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = priorOverflow;
      priorFocus?.focus();
    };
  }, []);

  return (
    <div className="samograph-modal">
      <div className="samograph-modal-backdrop" data-testid="modal-backdrop" onClick={onClose} />
      <div
        ref={dialogRef}
        className="samograph-modal-panel"
        data-testid="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
