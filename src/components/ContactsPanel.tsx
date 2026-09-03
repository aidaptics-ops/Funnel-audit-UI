"use client";

import { useState } from "react";
import type { ContactCandidate } from "@/lib/types";
import { Card } from "./ui";

/**
 * Every address found for a funnel, and which one will be used.
 *
 * Two rules the earlier version broke. Nothing is hidden for being
 * unapproved — the operator needs the whole list to choose from, and an
 * address dropped here is an address they can never pick. And approval is
 * persisted, so this component renders server state rather than owning it:
 * leaving the page and coming back shows the same answer.
 */
export function ContactsPanel({
  contacts,
  founderName,
  onApprove,
  onClear,
  busy = false,
  title = "Discovered emails",
  footer,
}: {
  contacts: ContactCandidate[];
  founderName?: string | null;
  onApprove?: (address: string) => void;
  onClear?: () => void;
  busy?: boolean;
  title?: string;
  /** Rendered under the list — where the "view the email" action belongs. */
  footer?: React.ReactNode;
}) {
  const [manual, setManual] = useState("");
  const approved = contacts.find((entry) => entry.approved) ?? null;

  return (
    <Card
      title={title}
      subtitle={
        founderName
          ? `${contacts.length} address(es) for ${founderName}`
          : `${contacts.length} address(es) found`
      }
    >
      {contacts.length === 0 ? (
        <p className="text-[13px] leading-relaxed text-ink-subtle">
          No addresses were found for this funnel. You can still enter one below.
        </p>
      ) : (
        <ul className="space-y-2">
          {contacts.map((contact) => (
            <li
              key={contact.address}
              className={`rounded-lg border p-3 ${
                contact.approved ? "border-done/40 bg-done-soft" : "border-line bg-surface-sunken"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] text-ink">{contact.address}</span>
                <Verdict result={contact.verification} />
                {contact.approved && <Tag tone="ok">approved</Tag>}
              </div>

              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-ink-subtle">{contact.source}</span>

                {onApprove && (
                  <div className="flex gap-2">
                    {contact.approved ? (
                      onClear && (
                        <button
                          type="button"
                          onClick={onClear}
                          disabled={busy}
                          className="text-xs font-medium text-ink-subtle hover:text-ink disabled:opacity-60"
                        >
                          Un-approve
                        </button>
                      )
                    ) : (
                      <button
                        type="button"
                        onClick={() => onApprove(contact.address)}
                        disabled={busy}
                        className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:bg-surface disabled:opacity-60"
                      >
                        Use this
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {onApprove && (
        <div className="mt-4 border-t border-line pt-3.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
            Or enter one yourself
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              value={manual}
              onChange={(event) => setManual(event.target.value)}
              placeholder="name@company.com"
              className="min-w-[14rem] flex-1 rounded-lg border border-line-strong bg-surface px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              disabled={busy || !manual.includes("@")}
              onClick={() => {
                onApprove(manual.trim());
                setManual("");
              }}
              className="rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-on-solid transition-colors hover:bg-accent-hover disabled:bg-line-strong disabled:text-ink-subtle"
            >
              Approve
            </button>
          </div>
        </div>
      )}

      <p className="mt-3 text-xs leading-relaxed text-ink-subtle">
        {approved
          ? `Outreach will use ${approved.address}. You can change this at any time.`
          : "Nothing is approved yet, so no address will be used. Approving one designates it for outreach — the rest stay here."}
      </p>

      {footer && <div className="mt-4 border-t border-line pt-4">{footer}</div>}
    </Card>
  );
}

/**
 * Three outcomes, not two. "Accepts all" means the domain answers for every
 * address, so it neither confirms nor refutes the mailbox.
 */
function Verdict({ result }: { result: string | null }) {
  if (!result) return <Tag tone="muted">not checked</Tag>;
  if (result === "valid") return <Tag tone="ok">verified</Tag>;
  if (result === "invalid" || result === "disposable") return <Tag tone="bad">{result}</Tag>;
  return <Tag tone="warn">{result === "catchall" ? "accepts all" : result}</Tag>;
}

function Tag({ tone, children }: { tone: "ok" | "warn" | "bad" | "muted"; children: React.ReactNode }) {
  const styles = {
    ok: "bg-done-soft text-done",
    warn: "bg-review-soft text-review",
    bad: "bg-broken-soft text-broken",
    muted: "bg-surface text-ink-subtle ring-1 ring-line",
  }[tone];
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${styles}`}>
      {children}
    </span>
  );
}
