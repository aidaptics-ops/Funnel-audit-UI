"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Notice } from "./ui";
import type { ApiEnvelope } from "@/lib/types";

/**
 * Screenshots of the pages the crawler cannot reach.
 *
 * The audit renders exactly one page and never converts, so a confirmation or
 * thank-you page is invisible to it — and the generator is deliberately
 * forbidden from describing one, because everything it could say would be
 * invented. This is the way round that: book the call yourself, photograph
 * what you land on, and the page becomes ordinary evidence.
 *
 * Uploading one also settles the "did you really convert" question, so the
 * email is allowed to open the way the client normally does.
 */
export interface SuppliedPage {
  id: string;
  label: string;
  mediaType: string;
  bytes: number;
  addedAt: string;
}

const SUGGESTIONS = ["confirmation page", "thank-you page", "booking screen", "checkout page"];

export function SuppliedPagesPanel({
  url,
  busy = false,
  onChanged,
}: {
  url: string;
  busy?: boolean;
  /** Fired after an upload or removal, so the caller can offer a rewrite. */
  onChanged?: (pages: SuppliedPage[]) => void;
}) {
  const [pages, setPages] = useState<SuppliedPage[]>([]);
  const [label, setLabel] = useState(SUGGESTIONS[0]!);
  const [notice, setNotice] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const apply = useCallback(
    (next: SuppliedPage[]) => {
      setPages(next);
      onChanged?.(next);
    },
    [onChanged],
  );

  useEffect(() => {
    let alive = true;
    void fetch(`/api/attachments?url=${encodeURIComponent(url)}`)
      .then((response) => response.json())
      .then((payload: ApiEnvelope<{ pages: SuppliedPage[] }>) => {
        if (alive && payload.ok && payload.data) setPages(payload.data.pages);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [url]);

  const upload = async (file: File): Promise<void> => {
    setWorking(true);
    setNotice(null);
    try {
      // Multipart rather than base64: a 5MB screenshot is 6.7MB once encoded.
      const form = new FormData();
      form.set("url", url);
      form.set("label", label);
      form.set("file", file);

      const response = await fetch("/api/attachments", { method: "POST", body: form });
      const payload = (await response.json()) as ApiEnvelope<{ pages: SuppliedPage[] }>;
      if (!payload.ok || !payload.data) {
        setNotice(payload.error?.message ?? "That upload did not work.");
        return;
      }
      apply(payload.data.pages);
      setNotice(`Added "${label}". Rewrite the email to use it.`);
    } catch {
      setNotice("Could not reach the server.");
    } finally {
      setWorking(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setWorking(true);
    try {
      const response = await fetch(
        `/api/attachments?url=${encodeURIComponent(url)}&id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      const payload = (await response.json()) as ApiEnvelope<{ pages: SuppliedPage[] }>;
      if (payload.ok && payload.data) apply(payload.data.pages);
    } catch {
      setNotice("Could not reach the server.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <Card
      title="Pages you screenshot yourself"
      subtitle="The crawler stops at the landing page. Book the call, screenshot what you land on, and the email can talk about it directly."
    >
      {pages.length > 0 && (
        <ul className="mb-4 space-y-2">
          {pages.map((page) => (
            <li
              key={page.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-sunken px-3 py-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-done" fill="none" aria-hidden>
                  <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" stroke="currentColor" strokeWidth="1.4" />
                  <circle cx="5.75" cy="6.25" r="1.1" fill="currentColor" />
                  <path d="M2.5 11.5 6 8.5l2.5 2 2-1.5 3 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                </svg>
                <span className="truncate text-[13px] text-ink">{page.label}</span>
                <span data-numeric className="shrink-0 text-[11px] text-ink-subtle">
                  {Math.round(page.bytes / 1024)}KB
                </span>
              </span>
              <button
                type="button"
                onClick={() => void remove(page.id)}
                disabled={working || busy}
                className="shrink-0 rounded px-2 py-1 text-xs font-medium text-ink-subtle transition-colors hover:bg-broken-soft hover:text-broken disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          disabled={working || busy}
          className="rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13px] text-ink focus:border-accent focus:outline-none"
        >
          {SUGGESTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>

        <label
          className={`cursor-pointer rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-[13px] font-medium text-ink-muted transition-colors hover:bg-surface-sunken ${
            working || busy ? "pointer-events-none opacity-60" : ""
          }`}
        >
          {working ? "Uploading…" : "Add screenshot"}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = "";
            }}
          />
        </label>
      </div>

      {notice && (
        <div className="mt-3">
          <Notice>{notice}</Notice>
        </div>
      )}

      <p className="mt-3 text-xs leading-relaxed text-ink-subtle">
        PNG, JPEG or WebP, up to 5MB each. Without one, the email can only raise those later stages as an
        opportunity — it is not allowed to describe a page nobody has seen.
      </p>
    </Card>
  );
}

/** The rewrite button that makes an upload worth doing. */
export function RewriteWithPages({
  count,
  busy,
  onRewrite,
}: {
  count: number;
  busy: boolean;
  onRewrite: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line-accent/45 bg-accent-soft px-4 py-3">
      <span className="text-[13px] text-ink">
        {count} screenshot{count === 1 ? "" : "s"} attached. The email does not use{" "}
        {count === 1 ? "it" : "them"} until you rewrite it.
      </span>
      <Button size="sm" onClick={onRewrite} disabled={busy}>
        {busy ? "Rewriting…" : "Rewrite the email"}
      </Button>
    </div>
  );
}
