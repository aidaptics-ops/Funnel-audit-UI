"use client";

import { useState } from "react";
import type { FunnelItem } from "@/lib/types";
import { Button, Card, Notice } from "./ui";

/** Review, edit and approve the generated email. Never sends anything. */
export function EmailPanel({
  item,
  onRegenerate,
  onEdit,
  onApprove,
  onSave,
  busy,
}: {
  item: FunnelItem;
  onRegenerate: () => void;
  onEdit: (edited: { subject: string; email: string }) => void;
  onApprove: () => void;
  onSave: () => void;
  busy: boolean;
}) {
  const email = item.email;
  // The displayed values are derived from props; draft state exists only while
  // the operator is editing, so there is nothing to keep in sync.
  const [draft, setDraft] = useState<{ subject: string; email: string } | null>(null);
  const [showInternals, setShowInternals] = useState(false);

  const editing = draft !== null;
  const subject = draft?.subject ?? item.editedEmail?.subject ?? email?.subject ?? "";
  const body = draft?.email ?? item.editedEmail?.email ?? email?.email ?? "";

  if (!email) {
    return (
      <Card title="Outreach">
        <Notice tone={item.notice ? "warn" : "info"}>
          {item.notice ?? "No email yet. Run an analysis, or regenerate once the audit is in."}
        </Notice>
        {item.audit && (
          <div className="mt-3">
            <Button onClick={onRegenerate} disabled={busy}>
              Generate email
            </Button>
          </div>
        )}
      </Card>
    );
  }

  const dirty = draft !== null && (draft.subject !== (email.subject ?? "") || draft.email !== (email.email ?? ""));

  const commit = (): void => {
    if (draft) onEdit({ subject: draft.subject, email: draft.email });
    setDraft(null);
  };

  return (
    <Card
      title="Outreach"
      action={
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setShowInternals(!showInternals)}>
            {showInternals ? "Hide reasoning" : "Why this angle"}
          </Button>
          <Button variant="secondary" onClick={onRegenerate} disabled={busy}>
            Regenerate
          </Button>
        </div>
      }
    >
      {item.notice && (
        <div className="mb-3">
          <Notice tone="warn">{item.notice}</Notice>
        </div>
      )}

      {email.warnings && email.warnings.length > 0 && (
        <div className="mb-3">
          <Notice tone="warn">
            <p className="font-medium">
              {email.warnings.length} guardrail flag{email.warnings.length === 1 ? "" : "s"} — review before sending
            </p>
            <ul className="mt-1 space-y-1">
              {email.warnings.map((warning, index) => (
                <li key={index}>
                  <span className="font-mono text-xs">{warning.kind}</span>: {warning.explanation}
                </li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      {email.regenerated && (
        <div className="mb-3">
          <Notice tone="info">
            The first draft asserted something the audit could not evidence, so it was automatically rewritten.
          </Notice>
        </div>
      )}

      <div className="space-y-3">
        <div>
          <label className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">Subject</label>
          {editing ? (
            <input
              value={subject}
              onChange={(event) => setDraft({ subject: event.target.value, email: body })}
              className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
          ) : (
            <p className="mt-1 text-sm font-medium text-ink">{subject}</p>
          )}
        </div>

        <div>
          <label className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">Email</label>
          {editing ? (
            <textarea
              value={body}
              onChange={(event) => setDraft({ subject, email: event.target.value })}
              rows={14}
              className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 font-mono text-sm leading-relaxed focus:border-accent focus:outline-none"
            />
          ) : (
            <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-surface-sunken px-3 py-3 text-sm leading-relaxed text-ink">
              {body}
            </pre>
          )}
        </div>
      </div>

      {showInternals && (
        <div className="mt-4 space-y-2 rounded-lg border border-line bg-surface-sunken px-3 py-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">Angle</p>
            <p className="mt-0.5 text-sm text-ink-muted">{email.angle || "—"}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">Personalization points</p>
            <ul className="mt-0.5 list-disc pl-5 text-sm text-ink-muted">
              {email.personalization_points.length ? (
                email.personalization_points.map((point, index) => <li key={index}>{point}</li>)
              ) : (
                <li className="list-none text-ink-subtle">—</li>
              )}
            </ul>
          </div>
          {email.provider && (
            <p className="text-xs text-ink-subtle">
              Generated by <span className="font-mono">{email.provider}</span>
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
        {editing ? (
          <>
            <Button onClick={commit} disabled={!dirty}>
              Save edits
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={() => setDraft({ subject, email: body })}>
            Edit
          </Button>
        )}
        <Button onClick={onApprove} disabled={item.stage === "approved" || item.stage === "saved"}>
          {item.stage === "approved" || item.stage === "saved" ? "Approved" : "Approve"}
        </Button>
        <Button variant="secondary" onClick={onSave} disabled={item.stage === "saved" || item.saving === true}>
          {item.stage === "saved" ? "Saved" : item.saving ? "Saving…" : "Save"}
        </Button>
        <span className="ml-auto self-center text-xs text-ink-subtle">
          Nothing is sent from here. Saving records the email for outreach.
        </span>
      </div>
    </Card>
  );
}
