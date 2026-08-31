"use client";

import { useEffect, useRef } from "react";
import { Button } from "./ui";

/**
 * A blocking confirmation for something irreversible.
 *
 * Built on <dialog> so the browser supplies the modal behaviour that is easy
 * to get wrong by hand: focus is trapped inside, the rest of the page is inert,
 * and Escape closes. The destructive button is never the one focus lands on —
 * a stray Enter should cancel, not delete.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Delete",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
      // Focus Cancel, not Confirm: the safe choice should be the default one.
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Escape and the backdrop both fire "cancel"/"close" natively.
    const handleCancel = (event: Event): void => {
      event.preventDefault();
      if (!busy) onCancel();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [onCancel, busy]);

  return (
    <dialog
      ref={ref}
      className="modal-panel backdrop:bg-ink-strong/40 backdrop:backdrop-blur-[2px]"
      aria-labelledby="confirm-title"
    >
      {/* Centred by the dialog around it, which fills the viewport. */}
      <div className="w-full max-w-md overflow-hidden rounded-modal border border-line bg-surface text-ink shadow-modal">
      <div className="px-5 py-4">
        <h2 id="confirm-title" className="text-[15px] font-semibold tracking-tight text-ink">
          {title}
        </h2>
        <div className="mt-2 text-[13px] leading-relaxed text-ink-muted">{body}</div>
      </div>

      <div className="flex justify-end gap-2 border-t border-line bg-surface-sunken px-5 py-3">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-surface-sunken disabled:opacity-60"
        >
          Cancel
        </button>
        <Button variant="danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Deleting…" : confirmLabel}
        </Button>
      </div>
      </div>
    </dialog>
  );
}
