"use client";

import { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./ui";

/**
 * The generated email, read the way it will be sent.
 *
 * Set as prose rather than in a code block: this is a letter someone is about
 * to send, and reviewing it in monospace makes it impossible to judge how it
 * will actually land. A measured line length and real paragraph spacing are
 * doing the work here.
 */
export function EmailModal({
  open,
  onClose,
  subject,
  body,
  angle,
  recipient,
  warnings = [],
}: {
  open: boolean;
  onClose: () => void;
  subject: string;
  body: string;
  angle?: string | null;
  /** The approved address, when one has been chosen. */
  recipient?: string | null;
  warnings?: { kind: string; explanation: string }[];
}) {
  const [copied, setCopied] = useState<"subject" | "body" | null>(null);

  const copy = async (text: string, which: "subject" | "body"): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      // Clipboard access can be refused; the text is on screen to select.
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="md"
      title="Generated email"
      subtitle={
        recipient ? (
          <span>
            To <span className="font-mono text-ink">{recipient}</span>
          </span>
        ) : (
          "No recipient approved yet — approve an address to set one."
        )
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => void copy(subject, "subject")}>
            {copied === "subject" ? "Subject copied" : "Copy subject"}
          </Button>
          <Button onClick={() => void copy(body, "body")}>
            {copied === "body" ? "Copied" : "Copy email"}
          </Button>
        </>
      }
    >
      {warnings.length > 0 && (
        <div className="mb-5 rounded-lg border border-review/30 bg-review-soft px-4 py-3">
          <p className="text-[13px] font-semibold text-ink">
            {warnings.length} guardrail flag{warnings.length === 1 ? "" : "s"} — review before sending
          </p>
          <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-ink-muted">
            {warnings.map((warning, index) => (
              <li key={index}>
                <span className="font-mono text-[11px] text-ink">{warning.kind}</span> — {warning.explanation}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-lg border border-line bg-surface-sunken px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">Subject</p>
        <p className="mt-1 text-[15px] font-medium leading-snug text-ink">{subject}</p>
      </div>

      {/*
        Rendered with whitespace preserved but in the body typeface. The email
        is written with deliberate line breaks between short paragraphs, and
        collapsing them would misrepresent how it reads in an inbox.
      */}
      <div className="mt-5 whitespace-pre-wrap text-[14px] leading-[1.75] text-ink [max-width:62ch]">
        {body}
      </div>

      {angle && (
        <div className="mt-6 border-t border-line pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
            Why this angle
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">{angle}</p>
        </div>
      )}
    </Modal>
  );
}
