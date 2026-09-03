"use client";

import { useEffect, useMemo, useState } from "react";
import { AuditPanel } from "@/components/AuditPanel";
import { IdentityPanel } from "@/components/IdentityPanel";
import { OwnerSearchPanel } from "@/components/OwnerSearchPanel";
import { ContactsPanel } from "@/components/ContactsPanel";
import { RunSummaryHeader } from "@/components/RunSummaryHeader";
import { EmailModal } from "@/components/EmailModal";
import { EmailPanel } from "@/components/EmailPanel";
import { SuppliedPagesPanel, RewriteWithPages, type SuppliedPage } from "@/components/SuppliedPagesPanel";
import { RunProgressCard } from "@/components/RunProgressCard";
import { StatusStrip } from "@/components/StatusStrip";
import { Button, Card, Empty, Metric, Notice, Progress, SeverityPill, StatusBadge } from "@/components/ui";
import { useFunnelQueue } from "@/hooks/useFunnelQueue";
import { extractUrls, mergeScreenshots } from "@/lib/url";
import {
  businessName,
  displayStatus,
  type ApiEnvelope,
  type DisplayStatus,
  type FunnelItem,
  type StatusPayload,
} from "@/lib/types";

type Filter = "all" | "active" | "needs_review" | "done" | "failed";

/**
 * The store's own per-run ceiling (MAX_PER_RUN in lib/attachments/store.ts),
 * mirrored here so the picker refuses a fifth file rather than letting the
 * server reject it after the upload has already been paid for.
 */
const MAX_SCREENSHOTS = 4;

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
  /**
   * Screenshots to attach, when the box above holds exactly one URL.
   *
   * A list rather than one file because a tall confirmation page has to be
   * split: a vision model scales an image so its long edge fits ~1568px, so a
   * single full-page capture of a 6,000px page arrives about 376px wide and
   * its text is unreadable. Four is the store's own per-run ceiling.
   *
   * Held in the order they will be READ, which is filename order rather than
   * the order they were clicked — a file picker returns its selection in the
   * directory's order, not the user's. Screenshot tools timestamp their files,
   * so capturing top-to-bottom already sorts correctly.
   */
  const [screenshots, setScreenshots] = useState<File[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [performedAction, setPerformedAction] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [emailOpen, setEmailOpen] = useState(false);
  // Screenshots the operator attached to the funnel currently on screen.
  const [supplied, setSupplied] = useState<SuppliedPage[]>([]);

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

  // Parsed the same way submit() parses it, so the dropzone's active/disabled
  // state can never disagree with how many URLs actually get queued — a raw
  // line count would go out of step the moment a pasted line held more than
  // one comma/semicolon-separated URL (extractUrls splits on those too).
  const parsedUrls = useMemo(() => extractUrls(input), [input]);
  // The screenshot column is only meaningful for a single funnel: pairing a
  // batch of screenshots with a batch of URLs by line position is exactly the
  // mis-attribution the old two-box pairing UI existed to prevent, and it is
  // not worth rebuilding here. A batch gets its screenshots afterward, per
  // funnel, from the existing panel below.
  const singleUrlLine = parsedUrls.length === 1;

  const queuedToast = (added: number, total: number, from?: string): string => {
    const where = from ? ` from ${from}` : "";
    const duplicates = total - added;
    const parts = [`${added} funnel${added === 1 ? "" : "s"} queued${where}`];
    if (duplicates > 0) parts.push(`${duplicates} already in the list`);
    return `${parts.join(" · ")}.`;
  };

  /**
   * Adds a picked selection to the list, in the order it will be read.
   *
   * Sorted by filename, NOT by the order the files were clicked: a file picker
   * hands back its selection in the directory's order, and the click order is
   * not recoverable. Screenshot tools timestamp their filenames, so a page
   * captured top to bottom already sorts into the right sequence — and the
   * numbered list makes a wrong one visible before anything is uploaded.
   *
   * Refuses past the store's own per-run ceiling rather than silently keeping
   * the first four: an operator who picks six and is told nothing would find
   * out from a strangely incomplete email days later.
   */
  const addScreenshots = (picked: FileList | null): void => {
    const chosen = [...(picked ?? [])];
    if (chosen.length === 0) return;

    // Computed from the committed list rather than inside the updater: React
    // runs an updater during a later render, so a setToast() in there would be
    // a side effect fired mid-render, and the message it needs is knowable now.
    const merged = mergeScreenshots(screenshots, chosen, MAX_SCREENSHOTS);
    setScreenshots(merged.files);
    if (merged.refused > 0) {
      setToast(
        merged.files.length >= MAX_SCREENSHOTS
          ? `A funnel holds ${MAX_SCREENSHOTS} screenshots — ${merged.refused} did not fit.`
          : `${merged.refused} could not be added.`,
      );
    }
  };

  /**
   * Attaches the queued screenshot to the funnel it was submitted for.
   *
   * Returns the server's own reason on failure — a rejected file has a real,
   * specific cause (the 5MB limit, an unsupported type) that /api/attachments
   * already states plainly; swallowing it left an operator staring at one
   * generic message for every possible failure, including the one he most
   * needed to see.
   */
  const uploadScreenshot = async (
    url: string,
    file: File,
    label: string,
  ): Promise<{ ok: boolean; message: string | null }> => {
    const form = new FormData();
    form.set("url", url);
    form.set("label", label);
    form.set("file", file);
    try {
      const response = await fetch("/api/attachments", { method: "POST", body: form });
      const payload = (await response.json()) as ApiEnvelope<unknown>;
      return { ok: Boolean(payload.ok), message: payload.error?.message ?? null };
    } catch {
      return { ok: false, message: null };
    }
  };

  /**
   * Uploads the chosen screenshots in the order they will be read.
   *
   * One at a time rather than in parallel: the store caps a run at four and
   * counts what is already on disk, so concurrent writes race that check.
   * Sequential is also what makes "1 of 3" mean the same thing here as it does
   * in the prompt.
   *
   * A failure does not abandon the rest — one file over 5MB should not cost
   * the operator the other three — and the reason the server gave is carried
   * back rather than replaced with a generic one.
   */
  const uploadScreenshots = async (url: string, files: File[]): Promise<string> => {
    const failures: string[] = [];
    let attached = 0;

    for (const [index, file] of files.entries()) {
      const label =
        files.length === 1 ? "confirmation page" : `confirmation page (${index + 1} of ${files.length})`;
      const result = await uploadScreenshot(url, file, label);
      if (result.ok) attached += 1;
      else failures.push(`${file.name}: ${result.message ?? "upload failed"}`);
    }

    if (failures.length === 0) {
      return ` ${attached} screenshot${attached === 1 ? "" : "s"} attached.`;
    }
    const kept = attached > 0 ? `${attached} attached, ` : "";
    return ` ${kept}${failures.length} could not be uploaded — ${failures[0]}`;
  };

  const submit = async (): Promise<void> => {
    const urls = parsedUrls;
    if (urls.length === 0) {
      setToast("No valid URLs found in that text.");
      return;
    }
    // Captured before the boxes are cleared below. Reuses the same parsedUrls
    // the dropzone's active state was computed from, so the two can never
    // disagree about whether this submission is a single-URL one.
    const single = urls.length === 1 ? urls[0]! : null;
    const pending = singleUrlLine ? screenshots : [];

    // Uploaded BEFORE the funnel is queued, not after. enqueue() adds the item
    // with stage "queued", and the worker effect picks it up and calls
    // /api/analyze on the very next render — which reads whatever screenshots
    // exist on disk at that instant. Uploading afterward raced that first
    // analysis and lost every time: the gate correctly found no screenshot
    // yet and withheld the email, even though one had just been chosen here.
    let screenshotNote = "";
    if (single && pending.length > 0) {
      screenshotNote = await uploadScreenshots(single, pending);
    }

    const added = queue.enqueue(urls, performedAction);
    setInput("");
    setScreenshots([]);
    setToast(queuedToast(added, urls.length) + (added > 0 ? screenshotNote : ""));
  };

  const onFile = async (file: File): Promise<void> => {
    const text = await file.text();
    const urls = extractUrls(text);
    if (urls.length === 0) {
      setToast(`No URLs found in ${file.name}.`);
      return;
    }
    const added = queue.enqueue(urls, performedAction);
    setToast(queuedToast(added, urls.length, file.name));
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 px-6 py-6">
      <StatusStrip status={status} />

      <Card
        title="Analyze funnels"
        subtitle="Paste one or more landing pages. They run one at a time — the analyser accepts a single page at once."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-ink-muted">Funnel landing page URL</span>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
              }}
              rows={3}
              placeholder={"https://example.com/offer\nhttps://example.com/webinar"}
              className="w-full resize-y rounded-lg border border-line-strong bg-surface px-3.5 py-2.5 font-mono text-[13px] leading-relaxed text-ink focus:border-accent focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-ink-muted">
              Post-booking / confirmation page screenshot
            </span>
            {singleUrlLine ? (
              <div className="space-y-2">
                <label className="flex h-[86px] w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line-strong bg-surface px-3.5 py-2.5 text-center transition-colors hover:bg-surface-sunken">
                  <span className="text-[13px] text-ink">
                    {screenshots.length === 0
                      ? "Choose screenshot(s)…"
                      : `${screenshots.length} of ${MAX_SCREENSHOTS} selected — add more`}
                  </span>
                  <span className="text-[11px] text-ink-subtle">
                    A tall page should be split top to bottom: one full-page capture arrives too narrow to read.
                  </span>
                  <input
                    type="file"
                    multiple
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(event) => {
                      addScreenshots(event.target.files);
                      // Cleared so re-picking the same file still fires onChange.
                      event.target.value = "";
                    }}
                  />
                </label>

                {screenshots.length > 0 && (
                  <ol className="space-y-1">
                    {screenshots.map((file, index) => (
                      <li
                        key={`${file.name}-${file.size}-${file.lastModified}`}
                        className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-sunken px-2.5 py-1.5"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span data-numeric className="shrink-0 text-[11px] text-ink-subtle">
                            {index + 1}
                          </span>
                          <span className="truncate text-[12px] text-ink" title={file.name}>
                            {file.name}
                          </span>
                          <span data-numeric className="shrink-0 text-[11px] text-ink-subtle">
                            {Math.round(file.size / 1024)}KB
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => setScreenshots((current) => current.filter((_, at) => at !== index))}
                          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-subtle transition-colors hover:bg-broken-soft hover:text-broken"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ) : (
              <div className="flex h-[86px] w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line bg-surface-sunken px-3.5 py-2.5 text-center opacity-70">
                <span className="text-[13px] text-ink-subtle">Only for a single URL above</span>
                <span className="text-[11px] text-ink-subtle">
                  A batch gets its screenshots added per funnel afterward, from the funnel&apos;s own panel.
                </span>
              </div>
            )}
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={() => void submit()} disabled={input.trim() === ""}>
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
          // Says what the list is scoped to, because the scope is now a real
          // boundary rather than a label: unfinished work always comes back,
          // finished work only while it is still recent, and everything older
          // lives on Runs.
          subtitle={
            filter === "all"
              ? "Work in flight, and what finished recently. Older runs are on the Runs page."
              : `Showing ${visible.length} of ${counts.total}`
          }
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
                // Named the same way as everywhere else, so a funnel does not
                // change identity depending on which list it appears in.
                const business = businessName(item);
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
                          {business || prettyUrl(item.url)}
                        </span>
                        <StatusBadge status={status} size="sm" />
                      </div>
                      {business && (
                        <p className="truncate text-xs text-ink-subtle" title={item.url}>
                          {prettyUrl(item.url)}
                        </p>
                      )}
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
                Queue a funnel above, or open a previous one from the Runs page. A full run takes about three to
                eight minutes — the page is read, both stages are analysed, the owner is researched, and the
                outreach email is drafted in the client&apos;s voice.
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
            <RunProgressCard
              // Keyed per funnel so the elapsed clock restarts rather than
              // carrying the previous run's start time into this one.
              key={selected.id}
              startedAt={selected.startedAt}
              queued={selected.stage === "queued"}
            />
          )}

          {selected && (selected.audit || selected.restoredAudit) && (
            <RunSummaryHeader
              url={selected.url}
              status={statuses.get(selected.id) ?? "queued"}
              business={businessName(selected)}
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

          {selected?.audit && (
            <>
              <SuppliedPagesPanel
                // Keyed per funnel: the panel holds its own list, and without
                // this it would show the previous funnel's screenshots.
                key={selected.url}
                url={selected.url}
                busy={selected.stage === "generating"}
                onChanged={setSupplied}
              />
              <RewriteWithPages
                count={supplied.length}
                busy={selected.stage === "generating"}
                onRewrite={() => void queue.regenerate(selected.id)}
              />
            </>
          )}

          {selected?.ownerSearch && <OwnerSearchPanel search={selected.ownerSearch} />}

          {selected?.audit && <AuditPanel audit={selected.audit} />}

          {selected && !selected.audit && selected.restoredAudit && (
            <RestoredRun
              run={selected.restoredAudit}
              url={selected.url}
              business={businessName(selected)}
              email={selected.email}
            />
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
  business,
  email,
}: {
  run: NonNullable<FunnelItem["restoredAudit"]>;
  url: string;
  /** Resolved by the caller, so this card names the same business as the header. */
  business: string | null;
  email: FunnelItem["email"];
}) {
  const issues = run.issues ?? [];
  return (
    <Card
      title={business || run.domain || "Saved run"}
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
