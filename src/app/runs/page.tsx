"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ago, Button, Card, Empty, Metric, Notice, SeverityPill, StatusBadge } from "@/components/ui";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ContactsPanel } from "@/components/ContactsPanel";
import { RunSummaryHeader } from "@/components/RunSummaryHeader";
import { EmailModal } from "@/components/EmailModal";
import { sortRuns, type RunSummary } from "@/lib/runs";
import { displayStatus, type ApiEnvelope, type DisplayStatus } from "@/lib/types";
import type { FunnelRecord } from "@/lib/sheets/types";
import { toRun } from "@/lib/runs";

type Filter = "all" | "waiting" | "needs_review" | "done" | "failed";

interface LoadResult {
  runs: RunSummary[];
  configured: boolean;
  error: string | null;
}

/** Pure fetch: it returns what it found and never touches React state. */
async function loadRuns(): Promise<LoadResult> {
  try {
    const response = await fetch("/api/records");
    const payload = (await response.json()) as ApiEnvelope<{
      records: FunnelRecord[];
      configured: boolean;
    }>;
    if (!payload.ok || !payload.data) {
      return { runs: [], configured: true, error: payload.error?.message ?? "Could not load the run history." };
    }
    return {
      runs: sortRuns(payload.data.records.map(toRun)),
      configured: payload.data.configured,
      error: null,
    };
  } catch {
    return { runs: [], configured: true, error: "Could not reach the server." };
  }
}

/**
 * Every funnel ever run, read back from the spreadsheet.
 *
 * The sheet is the source of truth on purpose: it survives restarts, other
 * machines, and the client opening the spreadsheet directly. Since queueing
 * became durable this page also shows work that has not run yet, which is why
 * "Waiting" is counted separately from "Completed".
 */
export default function RunsPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Held separately from the row: nothing is removed until this is confirmed.
  const [pendingDelete, setPendingDelete] = useState<RunSummary | null>(null);
  // Ticked rows, by URL. Held here rather than on the run so the selection
  // survives a refresh that replaces every RunSummary object.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingBulk, setPendingBulk] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /** State lands in the callback, never in the effect body. */
  const apply = useCallback((result: LoadResult) => {
    setConfigured(result.configured);
    setRuns(result.runs);
    setError(result.error);
    setRefreshing(false);
  }, []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void loadRuns().then(apply);
  }, [apply]);

  useEffect(() => {
    let alive = true;
    void loadRuns().then((result) => {
      if (alive) apply(result);
    });
    return () => {
      alive = false;
    };
  }, [apply]);

  const withStatus = useMemo(
    () =>
      (runs ?? []).map((run) => ({
        run,
        status: displayStatus({
          stage: run.stage,
          warningCount: run.warningCount,
          hasEmail: Boolean(run.emailSubject),
        }) as DisplayStatus,
      })),
    [runs],
  );

  const counts = useMemo(() => {
    const tally = { total: withStatus.length, waiting: 0, needs_review: 0, done: 0, failed: 0 };
    for (const { status } of withStatus) {
      // Queued rows live in the sheet now, so they would otherwise be counted
      // as completed work that nobody has done yet.
      if (status === "queued" || status === "analyzing" || status === "generating") tally.waiting += 1;
      else if (status === "needs_review") tally.needs_review += 1;
      else if (status === "failed") tally.failed += 1;
      else tally.done += 1;
    }
    return tally;
  }, [withStatus]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return withStatus.filter(({ run, status }) => {
      const waiting = status === "queued" || status === "analyzing" || status === "generating";
      if (filter === "waiting" && !waiting) return false;
      if (filter === "needs_review" && status !== "needs_review") return false;
      if (filter === "failed" && status !== "failed") return false;
      if (filter === "done" && (waiting || status === "needs_review" || status === "failed")) return false;
      if (!needle) return true;
      return (
        run.url.toLowerCase().includes(needle) ||
        run.domain.toLowerCase().includes(needle) ||
        run.brand.toLowerCase().includes(needle) ||
        run.ownerName.toLowerCase().includes(needle) ||
        run.ownerEmail.toLowerCase().includes(needle)
      );
    });
  }, [withStatus, filter, query]);

  const open = visible.find((entry) => entry.run.url === openUrl) ?? null;

  /**
   * Approving from the history page.
   *
   * The whole point of the change: the decision does not have to be made on
   * the Funnels page while the analysis is fresh. It can be made here, later,
   * and it sticks.
   */
  const approve = useCallback(
    async (url: string, address: string | null) => {
      setDeleting(true);
      try {
        const response = await fetch("/api/records", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url, approveEmail: address }),
        });
        const payload = (await response.json()) as ApiEnvelope<{ approved: string | null }>;
        setNotice(
          payload.ok
            ? payload.data?.approved
              ? `Approved ${payload.data.approved}.`
              : "Approval cleared."
            : (payload.error?.message ?? "Could not save that approval."),
        );
        void loadRuns().then(apply);
      } catch {
        setNotice("Could not reach the server.");
      } finally {
        setDeleting(false);
      }
    },
    [apply],
  );

  const toggle = useCallback((url: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }, []);

  /**
   * Deletes every ticked run.
   *
   * Sequential on purpose: the sheet writer serialises anyway, and firing ten
   * concurrent deletes at it would just queue behind the same lock while
   * making a partial failure harder to report.
   */
  const confirmBulkDelete = useCallback(async () => {
    const urls = [...selected];
    if (urls.length === 0) return;
    setDeleting(true);

    let removed = 0;
    let failed = 0;
    for (const url of urls) {
      try {
        const response = await fetch(`/api/records?url=${encodeURIComponent(url)}`, { method: "DELETE" });
        const payload = (await response.json()) as ApiEnvelope<{ removed: boolean }>;
        if (payload.ok && payload.data?.removed) removed += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }

    setNotice(
      failed === 0
        ? `Deleted ${removed} run${removed === 1 ? "" : "s"}.`
        : `Deleted ${removed}, but ${failed} could not be removed.`,
    );
    setSelected(new Set());
    setDeleting(false);
    setPendingBulk(false);
    if (openUrl && urls.includes(openUrl)) setOpenUrl(null);
    void loadRuns().then(apply);
  }, [selected, apply, openUrl]);

  const confirmDelete = useCallback(async () => {
    const target = pendingDelete;
    if (!target) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/records?url=${encodeURIComponent(target.url)}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as ApiEnvelope<{ removed: boolean }>;
      if (!payload.ok) {
        setNotice(payload.error?.message ?? "Could not delete that run.");
      } else {
        setNotice(
          payload.data?.removed
            ? "Run deleted."
            : "That run was already gone from the sheet.",
        );
        // Re-read rather than splicing locally, so the list matches the sheet.
        void loadRuns().then(apply);
        setSelected((current) => {
          const next = new Set(current);
          next.delete(target.url);
          return next;
        });
        if (openUrl === target.url) setOpenUrl(null);
      }
    } catch {
      setNotice("Could not reach the server.");
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }, [pendingDelete, apply, openUrl]);

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 px-6 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">Runs</h1>
          <p className="mt-0.5 text-[13px] text-ink-subtle">
            Every funnel analysed, read from your Google Sheet.
          </p>
        </div>
        <Button variant="secondary" onClick={refresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {!configured && (
        <Notice tone="warn" title="Google Sheets is not connected">
          History is stored in the spreadsheet, so nothing can be listed until it is configured. See
          docs/GOOGLE_SHEETS.md.
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}

      {runs !== null && runs.length > 0 && (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
          <Metric label="Total runs" value={counts.total} active={filter === "all"} onClick={() => setFilter("all")} />
          <Metric
            label="Waiting"
            value={counts.waiting}
            tone="busy"
            active={filter === "waiting"}
            onClick={() => setFilter("waiting")}
          />
          <Metric
            label="Needs review"
            value={counts.needs_review}
            tone="review"
            active={filter === "needs_review"}
            onClick={() => setFilter("needs_review")}
          />
          <Metric
            label="Completed"
            value={counts.done}
            tone="done"
            active={filter === "done"}
            onClick={() => setFilter("done")}
          />
          <Metric
            label="Failed"
            value={counts.failed}
            tone="broken"
            active={filter === "failed"}
            onClick={() => setFilter("failed")}
          />
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        <Card
          title={
            selected.size > 0 ? (
              <span className="flex items-center gap-3">
                <span>{selected.size} selected</span>
                <button
                  type="button"
                  onClick={() => setPendingBulk(true)}
                  className="rounded-md border border-broken/30 bg-broken-soft px-2.5 py-1 text-xs font-medium text-broken transition-colors hover:bg-broken/10"
                >
                  Delete selected
                </button>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="text-xs font-medium text-ink-subtle hover:text-ink"
                >
                  Clear
                </button>
              </span>
            ) : (
              "History"
            )
          }
          subtitle={runs === null ? "Loading…" : `${visible.length} of ${counts.total} shown`}
          action={
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search domain, owner, email…"
              className="w-52 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
            />
          }
          padded={false}
        >
          {runs === null ? (
            <Empty title="Loading">Reading the spreadsheet…</Empty>
          ) : visible.length === 0 ? (
            <Empty title={counts.total === 0 ? "No runs yet" : "Nothing matches"}>
              {counts.total === 0
                ? "Analyse a funnel on the Funnels page. Each one is written here automatically."
                : "Try a different filter or search term."}
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-wider text-ink-subtle">
                    <th className="w-9 py-2.5 pl-5 pr-0">
                      <input
                        type="checkbox"
                        aria-label="Select all shown runs"
                        // Scoped to what is on screen: with a filter or search
                        // active, "all" must mean the rows they can see, not
                        // every row in the sheet.
                        checked={visible.length > 0 && visible.every(({ run }) => selected.has(run.url))}
                        ref={(node) => {
                          if (node) {
                            const some = visible.some(({ run }) => selected.has(run.url));
                            const all = visible.length > 0 && visible.every(({ run }) => selected.has(run.url));
                            node.indeterminate = some && !all;
                          }
                        }}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked ? new Set(visible.map(({ run }) => run.url)) : new Set(),
                          )
                        }
                        className="h-3.5 w-3.5 rounded border-line-strong accent-[oklch(0.47_0.17_264)]"
                      />
                    </th>
                    <th className="px-5 py-2.5 font-medium">Funnel</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-3 py-2.5 font-medium">Owner</th>
                    <th className="px-3 py-2.5 font-medium">Findings</th>
                    <th className="px-5 py-2.5 font-medium">Updated</th>
                    <th className="px-3 py-2.5 font-medium"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(({ run, status }) => (
                    <tr
                      key={run.url}
                      onClick={() => setOpenUrl(run.url === openUrl ? null : run.url)}
                      className={`cursor-pointer border-b border-line/70 transition-colors last:border-0 ${
                        run.url === openUrl ? "bg-accent-soft" : "hover:bg-surface-sunken"
                      }`}
                    >
                      <td className="w-9 py-3 pl-5 pr-0" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${run.domain || run.url}`}
                          checked={selected.has(run.url)}
                          onChange={() => toggle(run.url)}
                          className="h-3.5 w-3.5 rounded border-line-strong accent-[oklch(0.47_0.17_264)]"
                        />
                      </td>
                      <td className="max-w-[280px] px-5 py-3">
                        <p className="truncate font-medium text-ink" title={run.url}>
                          {run.brand || run.domain || prettyUrl(run.url)}
                        </p>
                        <p className="truncate text-xs text-ink-subtle" title={run.url}>
                          {prettyUrl(run.url)}
                        </p>
                      </td>
                      <td className="px-3 py-3">
                        <StatusBadge status={status} size="sm" />
                      </td>
                      <td className="max-w-[180px] px-3 py-3">
                        {run.ownerName || run.ownerEmail ? (
                          <>
                            <p className="truncate text-ink">{run.ownerName || "—"}</p>
                            <p className="truncate font-mono text-xs text-ink-subtle">{run.ownerEmail}</p>
                          </>
                        ) : (
                          <span className="text-ink-subtle">not identified</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <span data-numeric className="text-ink">
                          {run.issueCount || run.topIssues.length}
                        </span>
                        {run.warningCount > 0 && (
                          <span className="ml-2 text-xs text-review">{run.warningCount} warning</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3">
                        <Ago iso={run.updatedAt} />
                      </td>
                      <td className="px-3 py-3 text-right">
                        <button
                          type="button"
                          aria-label={`Delete run for ${run.domain || run.url}`}
                          onClick={(event) => {
                            // The row is a link; deleting must not also open it.
                            event.stopPropagation();
                            setPendingDelete(run);
                          }}
                          className="rounded px-2 py-1 text-xs font-medium text-ink-subtle transition-colors hover:bg-broken-soft hover:text-broken"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div>
          {open ? (
            <RunDetail run={open.run} status={open.status} onApprove={approve} busy={deleting} />
          ) : (
            <Card title="Run detail">
              <Empty title="Nothing selected">
                Pick a row to see its findings, the email that was written, and the contact address that was
                approved.
              </Empty>
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingBulk}
        busy={deleting}
        title={`Delete ${selected.size} run${selected.size === 1 ? "" : "s"}?`}
        confirmLabel={`Delete ${selected.size} run${selected.size === 1 ? "" : "s"}`}
        onCancel={() => setPendingBulk(false)}
        onConfirm={() => void confirmBulkDelete()}
        body={
          <>
            <p>
              This permanently removes {selected.size} run
              {selected.size === 1 ? "" : "s"} and their analysis, findings, emails and contact details.
            </p>
            <p className="mt-2">The rows are deleted from your Google Sheet. This cannot be undone.</p>
          </>
        }
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        busy={deleting}
        title="Delete this run?"
        confirmLabel="Delete run"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
        body={
          <>
            <p>
              This permanently removes the run for{" "}
              <span className="font-mono text-xs text-ink">
                {pendingDelete ? prettyUrl(pendingDelete.url) : ""}
              </span>{" "}
              and its analysis, findings, email and contact details.
            </p>
            <p className="mt-2">The row is deleted from your Google Sheet. This cannot be undone.</p>
          </>
        }
      />
    </div>
  );
}

function RunDetail({
  run,
  status,
  onApprove,
  busy,
}: {
  run: RunSummary;
  status: DisplayStatus;
  onApprove: (url: string, address: string | null) => void;
  busy: boolean;
}) {
  const issues = run.audit?.issues ?? [];
  const [emailOpen, setEmailOpen] = useState(false);
  const approved = run.contacts.find((entry) => entry.approved) ?? null;

  return (
    <div className="space-y-4">
      {/* The answer first. Everything below is supporting detail. */}
      <RunSummaryHeader
        url={run.url}
        status={status}
        // The identified business only. The domain belongs in the row label,
        // where it identifies a line; here it would be asserting that the
        // business is called "example.com".
        business={run.brand || null}
        founder={run.ownerName || null}
        founderRole={run.funnelType || null}
        approvedEmail={approved?.address ?? run.ownerEmail ?? null}
        verification={approved?.verification ?? null}
        contactCount={run.contacts.length}
        hasEmail={Boolean(run.emailSubject)}
        onViewEmail={() => setEmailOpen(true)}
      />

      <EmailModal
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        subject={run.emailSubject}
        body={run.emailBody}
        angle={run.emailAngle}
        recipient={approved?.address ?? run.ownerEmail ?? null}
      />

      {run.errorMessage && <Notice tone="error">{run.errorMessage}</Notice>}

      <ContactsPanel
        contacts={run.contacts}
        founderName={run.ownerName}
        busy={busy}
        title="Discovered emails"
        onApprove={(address) => onApprove(run.url, address)}
        onClear={() => onApprove(run.url, null)}
      />

      {run.audit?.headline && (
        <Card title="What the page says">
          <p className="text-[14px] leading-relaxed text-ink">&ldquo;{run.audit.headline}&rdquo;</p>
          <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-3.5">
            <Detail label="Funnel type" value={run.funnelType} />
            <Detail label="Goal" value={run.conversionGoal} />
            <Detail label="Address type" value={run.ownerEmailKind.replace(/_/g, " ")} />
            <Detail label="Analysed" value={run.createdAt ? new Date(run.createdAt).toLocaleString() : ""} />
          </dl>
        </Card>
      )}

      {issues.length > 0 && (
        <Card title={`Findings (${issues.length})`}>
          <ul className="space-y-3">
            {issues.map((issue, index) => (
              <li key={`${issue.id ?? index}`} className="border-b border-line pb-3 last:border-0 last:pb-0">
                <div className="flex items-start gap-2">
                  <SeverityPill severity={issue.severity ?? "low"} />
                  <p className="text-[13px] font-medium text-ink">{issue.title}</p>
                </div>
                {issue.description && (
                  <p className="mt-1 text-xs leading-relaxed text-ink-muted">{issue.description}</p>
                )}
                {issue.recommendation && (
                  <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
                    <span className="font-medium">Fix:</span> {issue.recommendation}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!run.audit && run.topIssues.length > 0 && (
        <Card title="Findings">
          <ul className="space-y-1.5 text-[13px] text-ink">
            {run.topIssues.map((issue) => (
              <li key={issue}>· {issue}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-subtle">
            This row was written before full findings were stored. Re-analyse the funnel for the complete audit.
          </p>
        </Card>
      )}
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd className={`mt-1 truncate text-[13px] text-ink ${mono ? "font-mono text-xs" : ""}`} title={value}>
        {value || <span className="text-ink-subtle">—</span>}
      </dd>
    </div>
  );
}

function prettyUrl(url: string): string {
  const bare = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const [head] = bare.split("?");
  return (head ?? bare).replace(/\/$/, "");
}
