"use client";

import { useEffect, useMemo, useState } from "react";
import { AuditPanel } from "@/components/AuditPanel";
import { IdentityPanel } from "@/components/IdentityPanel";
import { OwnerSearchPanel } from "@/components/OwnerSearchPanel";
import { ContactsPanel } from "@/components/ContactsPanel";
import { RunSummaryHeader } from "@/components/RunSummaryHeader";
import { EmailModal } from "@/components/EmailModal";
import { EmailPanel } from "@/components/EmailPanel";
import { StatusStrip } from "@/components/StatusStrip";
import { Button, Card, Empty, Metric, Notice, Progress, SeverityPill, StatusBadge } from "@/components/ui";
import { useFunnelQueue } from "@/hooks/useFunnelQueue";
import { extractUrls } from "@/lib/url";
import { displayStatus, type DisplayStatus, type FunnelItem, type StatusPayload } from "@/lib/types";

type Filter = "all" | "active" | "needs_review" | "done" | "failed";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "In progress" },
  { id: "needs_review", label: "Needs review" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" },
];

export default function DashboardPage() {
  const queue = useFunnelQueue();
  const [input, setInput] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [performedAction, setPerformedAction] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [emailOpen, setEmailOpen] = useState(false);

  useEffect(() => {
    void fetch("/api/status")
      .then((response) => response.json())
      .then((payload) => setStatus(payload.data ?? null))
      .catch(() => setStatus(null));
  }, []);

  // Every item's presentation status, computed once per render.
  const statuses = useMemo(
    () =>
      new Map<string, DisplayStatus>(
        queue.items.map((item) => [
          item.id,
          displayStatus({
            stage: item.stage,
            warningCount: item.email?.warnings?.length ?? 0,
            hasEmail: Boolean(item.email),
          }),
        ]),
      ),
    [queue.items],
  );

  const counts = useMemo(() => {
    const tally = { total: queue.items.length, active: 0, needs_review: 0, done: 0, failed: 0 };
    for (const status of statuses.values()) {
      if (status === "queued" || status === "analyzing" || status === "generating") tally.active += 1;
      else if (status === "needs_review") tally.needs_review += 1;
      else if (status === "failed") tally.failed += 1;
      else tally.done += 1;
    }
    return tally;
  }, [statuses, queue.items.length]);

  const visible = useMemo(
    () =>
      queue.items.filter((item) => {
        const status = statuses.get(item.id)!;
        if (filter === "all") return true;
        if (filter === "active") return status === "queued" || status === "analyzing" || status === "generating";
        if (filter === "needs_review") return status === "needs_review";
        if (filter === "failed") return status === "failed";
        return status === "ready" || status === "approved" || status === "saved";
      }),
    [queue.items, statuses, filter],
  );

  // Derived, not synced: an explicit choice wins, otherwise follow the funnel
  // that is currently interesting. No effect, so no cascading render.
  const selected = useMemo(() => {
    const picked = selectedId ? queue.items.find((item) => item.id === selectedId) : undefined;
    if (picked) return picked;
    return (
      queue.items.find((item) => statuses.get(item.id) === "needs_review") ??
      queue.items.find((item) => item.stage === "ready") ??
      queue.items.find((item) => item.stage === "analyzing") ??
      queue.items[0] ??
      null
    );
  }, [queue.items, selectedId, statuses]);

  const submit = (): void => {
    const urls = extractUrls(input);
    if (urls.length === 0) {
      setToast("No valid URLs found in that text.");
      return;
    }
    const added = queue.enqueue(urls, performedAction);
    setInput("");
    setToast(
      added === urls.length
        ? `${added} funnel${added === 1 ? "" : "s"} queued.`
        : `${added} queued · ${urls.length - added} already in the list.`,
    );
  };

  const onFile = async (file: File): Promise<void> => {
    const text = await file.text();
    const urls = extractUrls(text);
    if (urls.length === 0) {
      setToast(`No URLs found in ${file.name}.`);
      return;
    }
    const added = queue.enqueue(urls, performedAction);
    setToast(`${added} funnel${added === 1 ? "" : "s"} queued from ${file.name}.`);
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 px-6 py-6">
      <StatusStrip status={status} />

      <Card
        title="Analyze funnels"
        subtitle="One URL per line, or upload a CSV. They run one at a time — the analyser accepts a single page at once."
      >
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
          }}
          rows={3}
          placeholder={"https://example.com/offer\nhttps://example.com/webinar"}
          className="w-full resize-y rounded-lg border border-line-strong bg-surface px-3.5 py-2.5 font-mono text-[13px] leading-relaxed text-ink focus:border-accent focus:outline-none"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={submit} disabled={input.trim() === ""}>
            Analyze
          </Button>
          <label className="cursor-pointer rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-[13px] font-medium text-ink-muted transition-colors hover:bg-surface-sunken">
            Upload CSV
            <input
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onFile(file);
                event.target.value = "";
              }}
            />
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-muted">
            <input
              type="checkbox"
              checked={performedAction}
              onChange={(event) => setPerformedAction(event.target.checked)}
              className="h-4 w-4 rounded border-line-strong accent-[oklch(0.47_0.17_264)]"
            />
            I booked / bought / signed up on these myself
          </label>
          {queue.items.length > 0 && (
            <Button variant="ghost" onClick={queue.clearFinished}>
              Clear finished
            </Button>
          )}
        </div>

        {queue.running && counts.total > 1 && (
          <div className="mt-4 border-t border-line pt-3.5">
            <Progress done={counts.done + counts.needs_review + counts.failed} total={counts.total} />
          </div>
        )}

        {toast && (
          <div className="mt-3">
            <Notice>{toast}</Notice>
          </div>
        )}
      </Card>

      {queue.items.length > 0 && (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
          <Metric label="Total" value={counts.total} active={filter === "all"} onClick={() => setFilter("all")} />
          <Metric
            label="In progress"
            value={counts.active}
            tone="busy"
            active={filter === "active"}
            onClick={() => setFilter("active")}
          />
          <Metric
            label="Needs review"
            value={counts.needs_review}
            tone="review"
            active={filter === "needs_review"}
            onClick={() => setFilter("needs_review")}
          />
          <Metric
            label="Done"
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

      <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Card
          title="This session"
          subtitle={filter === "all" ? undefined : `Showing ${visible.length} of ${counts.total}`}
          action={
            filter !== "all" ? (
              <Button size="sm" variant="ghost" onClick={() => setFilter("all")}>
                Clear filter
              </Button>
            ) : undefined
          }
          padded={false}
        >
          {queue.items.length === 0 ? (
            <Empty title="Nothing queued yet">
              Paste one or more funnel URLs above. Past runs are on the Runs page.
            </Empty>
          ) : visible.length === 0 ? (
            <Empty title="Nothing matches this filter">
              {FILTERS.find((entry) => entry.id === filter)?.label} is empty right now.
            </Empty>
          ) : (
            <ul className="max-h-[560px] overflow-y-auto py-1.5">
              {visible.map((item) => {
                const status = statuses.get(item.id)!;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(item.id)}
                      className={`w-full border-l-2 px-4 py-2.5 text-left transition-colors ${
                        item.id === selected?.id
                          ? "border-accent bg-accent-soft"
                          : "border-transparent hover:bg-surface-sunken"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink" title={item.url}>
                          {prettyUrl(item.url)}
                        </span>
                        <StatusBadge status={status} size="sm" />
                      </div>
                      {item.error ? (
                        <p className="mt-1 line-clamp-2 text-xs text-broken">{item.error.message}</p>
                      ) : item.audit || item.restoredAudit ? (
                        <p className="mt-1 text-xs text-ink-subtle">
                          {item.audit?.funnelType ?? item.restoredAudit?.funnelType ?? "unknown"} ·{" "}
                          {(item.audit?.issues ?? item.restoredAudit?.issues ?? []).length} findings
                          {item.restored ? " · saved" : ""}
                          {item.email?.warnings?.length
                            ? ` · ${item.email.warnings.length} warning${item.email.warnings.length === 1 ? "" : "s"}`
                            : ""}
                        </p>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="min-w-0 space-y-5">
          {!selected && (
            <Card>
              <Empty title="Nothing selected">
                Queue a funnel above, or open a previous one from the Runs page. An audit takes 15–25 seconds,
                then the outreach email is drafted in the client&apos;s voice.
              </Empty>
            </Card>
          )}

          {selected && selected.stage === "failed" && (
            <Card title="Analysis failed">
              <Notice tone="error">{selected.error?.message ?? "Something went wrong."}</Notice>
              <div className="mt-3">
                <Button onClick={() => queue.retry(selected.id)}>Retry this funnel</Button>
              </div>
            </Card>
          )}

          {selected && (selected.stage === "queued" || selected.stage === "analyzing") && (
            <Card>
              <div className="flex items-center gap-3 py-5">
                <span className="h-2 w-2 animate-pulse rounded-full bg-busy" />
                <div>
                  <p className="text-[13px] font-medium text-ink">
                    {selected.stage === "queued" ? "Waiting its turn" : "Reading the page"}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-subtle">
                    {selected.stage === "queued"
                      ? "The analyser handles one funnel at a time."
                      : "Rendering it and recording what is actually there — usually 15–25 seconds."}
                  </p>
                </div>
              </div>
            </Card>
          )}

          {selected && (selected.audit || selected.restoredAudit) && (
            <RunSummaryHeader
              url={selected.url}
              status={statuses.get(selected.id) ?? "queued"}
              business={
                selected.identity?.company.brand ??
                selected.audit?.brand ??
                selected.restoredAudit?.brand ??
                null
              }
              founder={selected.identity?.owner?.fullName ?? selected.confirmedName ?? null}
              founderRole={selected.identity?.owner?.role ?? null}
              approvedEmail={selected.approvedEmail ?? null}
              verification={
                selected.contacts?.find((entry) => entry.approved)?.verification ?? null
              }
              contactCount={selected.contacts?.length ?? 0}
              hasEmail={Boolean(selected.email?.email)}
              onViewEmail={() => setEmailOpen(true)}
            />
          )}

          {selected?.email?.email && (
            <EmailModal
              open={emailOpen}
              onClose={() => setEmailOpen(false)}
              subject={selected.email.subject}
              body={selected.email.email}
              angle={selected.email.angle}
              recipient={selected.approvedEmail ?? null}
              warnings={selected.email.warnings ?? []}
            />
          )}

          {selected?.identity && (
            <IdentityPanel
              // Keyed per funnel: the confirm box holds local state, so without
              // this it keeps the previous funnel's name and email when the
              // selection changes.
              key={selected.id}
              identity={selected.identity}
              busy={selected.stage === "generating"}
              enriching={selected.enriching === true}
              hunter={status?.enrichment?.hunter ?? null}
              rocketreach={status?.enrichment?.rocketreach ?? null}
              profiles={selected.rocketReachProfiles ?? []}
              approvedEmail={selected.approvedEmail}
              onConfirm={(name, email) => void queue.confirmOwner(selected.id, name, email)}
              onEnrich={(provider, profileId) => void queue.enrich(selected.id, provider, profileId)}
              onApproveEmail={(address) => queue.approveEmail(selected.id, address)}
              onRejectEmail={(address) => queue.rejectEmail(selected.id, address)}
            />
          )}

          {selected && (selected.contacts?.length ?? 0) > 0 && (
            <ContactsPanel
              contacts={selected.contacts ?? []}
              founderName={selected.identity?.owner?.fullName ?? selected.confirmedName}
              busy={selected.stage === "generating"}
              onApprove={(address) => void queue.approveEmail(selected.id, address)}
              onClear={() => void queue.approveEmail(selected.id, null)}
            />
          )}

          {selected?.ownerSearch && <OwnerSearchPanel search={selected.ownerSearch} />}

          {selected?.audit && <AuditPanel audit={selected.audit} />}

          {selected && !selected.audit && selected.restoredAudit && (
            <RestoredRun run={selected.restoredAudit} url={selected.url} email={selected.email} />
          )}

          {selected?.audit && (
            <EmailPanel
              item={selected}
              busy={selected.stage === "generating"}
              onRegenerate={() => void queue.regenerate(selected.id)}
              onEdit={(edited) => queue.edit(selected.id, edited)}
              onApprove={() => queue.approve(selected.id)}
              onSave={() => void queue.save(selected.id).then((result) => setToast(result.message))}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A run read back from the sheet.
 *
 * Shows exactly what was stored — findings and the page's own words — rather
 * than feeding a partial object to the full audit panel, which reads counts
 * and capture details the summary never carried.
 */
function RestoredRun({
  run,
  url,
  email,
}: {
  run: NonNullable<FunnelItem["restoredAudit"]>;
  url: string;
  email: FunnelItem["email"];
}) {
  const issues = run.issues ?? [];
  return (
    <Card
      title={run.brand || run.domain || "Saved run"}
      subtitle={run.funnelType ? `${run.funnelType} · ${issues.length} findings` : `${issues.length} findings`}
      action={
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs font-medium text-accent hover:underline"
        >
          Open funnel
        </a>
      }
    >
      {run.headline && (
        <p className="text-[13px] leading-relaxed text-ink">&ldquo;{run.headline}&rdquo;</p>
      )}

      {issues.length > 0 && (
        <ul className="mt-3 space-y-2 border-t border-line pt-3">
          {issues.map((issue, index) => (
            <li key={issue.id ?? index} className="flex items-start gap-2 text-[13px]">
              <SeverityPill severity={issue.severity ?? "low"} />
              <span className="text-ink">{issue.title}</span>
            </li>
          ))}
        </ul>
      )}

      {email?.email && (
        <div className="mt-4 border-t border-line pt-3.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
            Email written for this run
          </p>
          <p className="mt-1.5 text-[13px] font-medium text-ink">{email.subject}</p>
          <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-surface-sunken p-3.5 font-sans text-[13px] leading-relaxed text-ink">
            {email.email}
          </pre>
        </div>
      )}

      <p className="mt-3 text-xs leading-relaxed text-ink-subtle">
        Restored from your saved runs. Re-analyse the funnel for the full audit and a fresh email.
      </p>
    </Card>
  );
}

/** Long tracked URLs are unreadable in a list; the path is what identifies them. */
function prettyUrl(url: string): string {
  const bare = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const [head] = bare.split("?");
  return (head ?? bare).replace(/\/$/, "");
}
