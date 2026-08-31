"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The one modal in the app.
 *
 * Built on <dialog> so the browser supplies the behaviour that is tedious and
 * easy to get subtly wrong by hand: focus trapped inside, the rest of the page
 * made inert, Escape to close, and a real top-layer backdrop that never fights
 * a z-index.
 */
export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = "md",
  initialFocus,
}: {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: "sm" | "md" | "lg";
  /** Where focus should land. Defaults to the close button. */
  initialFocus?: React.RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
      (initialFocus?.current ?? closeRef.current)?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, initialFocus]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Escape fires "cancel"; intercept so React owns the open state rather
    // than the DOM closing underneath it.
    const handle = (event: Event): void => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", handle);
    return () => dialog.removeEventListener("cancel", handle);
  }, [onClose]);

  const widths = { sm: "max-w-md", md: "max-w-2xl", lg: "max-w-4xl" }[width];

  return (
    <dialog
      ref={ref}
      aria-labelledby="modal-title"
      // Clicking the backdrop closes. The dialog element itself fills the
      // whole viewport, so the check is "did the click land outside the panel".
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={`modal-panel w-[calc(100vw-2rem)] ${widths} rounded-modal border border-line bg-surface p-0 text-ink shadow-modal backdrop:bg-ink-strong/40 backdrop:backdrop-blur-[2px]`}
    >
      <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
        <div className="min-w-0">
          <h2 id="modal-title" className="text-[15px] font-semibold tracking-tight text-ink">
            {title}
          </h2>
          {subtitle && <div className="mt-1 text-[13px] leading-relaxed text-ink-subtle">{subtitle}</div>}
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-1.5 -mt-1 shrink-0 rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      {/* Caps at the viewport so a long email scrolls inside the panel rather
          than pushing the footer off screen. */}
      <div className="max-h-[min(70vh,42rem)] overflow-y-auto px-6 py-5">{children}</div>

      {footer && (
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-sunken px-6 py-3.5">
          {footer}
        </footer>
      )}
    </dialog>
  );
}
