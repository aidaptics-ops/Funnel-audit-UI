"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Empty, Field, Notice } from "@/components/ui";
import type { ClientProfile } from "@/lib/client-knowledge/types";

interface EmailSummary {
  id: string;
  subject: string | null;
  preview: string;
  words: number;
  source: string;
  addedAt: string;
  tag: string | null;
}

interface LibraryPayload {
  count: number;
  emails: EmailSummary[];
  profile: ClientProfile | null;
  storage: { kind: string; durable: boolean };
}

/**
 * The client's email library and the profile derived from it.
 *
 * These emails teach the system two things: how this person writes, and what
 * they tend to notice. They are never used as evidence about a prospect's
 * funnel — that always comes from the audit.
 */
export default function ClientVoicePage() {
  const [library, setLibrary] = useState<LibraryPayload | null>(null);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "warn" | "error"; text: string } | null>(null);

  const load = useCallback(async (): Promise<boolean> => {
    const response = await fetch("/api/client-emails").catch(() => null);
    if (!response) return false;
    const payload = await response.json().catch(() => null);
    if (!payload) return false;
    setLibrary(payload.data ?? null);
    return true;
  }, []);

  useEffect(() => {
    let alive = true;
    async function initialLoad(): Promise<void> {
      const ok = await load();
      if (alive && !ok) setMessage({ tone: "error", text: "Could not load the email library." });
    }
    void initialLoad();
    return () => {
      alive = false;
    };
  }, [load]);

  const addPasted = async (): Promise<void> => {
    if (paste.trim() === "") return;
    setBusy(true);
    try {
      const response = await fetch("/api/client-emails", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: paste }),
      });
      const payload = await response.json();
      if (!payload.ok) {
        setMessage({ tone: "error", text: payload.error?.message ?? "Could not add those." });
      } else {
        setMessage({ tone: "info", text: `Added ${payload.data.added} email example(s).` });
        setPaste("");
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const upload = async (files: FileList): Promise<void> => {
    setBusy(true);
    try {
      const form = new FormData();
      for (const file of Array.from(files)) form.append("files", file);
      const response = await fetch("/api/client-emails", { method: "POST", body: form });
      const payload = await response.json();
      if (!payload.ok) {
        setMessage({ tone: "error", text: payload.error?.message ?? "Upload failed." });
      } else {
        setMessage({ tone: "info", text: `Added ${payload.data.added} email example(s).` });
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const refreshProfile = async (): Promise<void> => {
    setBusy(true);
    setMessage({ tone: "info", text: "Analysing the samples…" });
    try {
      const response = await fetch("/api/client-profile", { method: "POST" });
      const payload = await response.json();
      if (!payload.ok) {
        setMessage({ tone: "error", text: payload.error?.message ?? "Could not build the profile." });
      } else {
        // Use the profile this response just returned rather than re-fetching.
        // On serverless the re-fetch lands on a DIFFERENT instance from the one
        // that built it, reads an empty store, and reports "no profile" — which
        // is exactly why Refresh appeared to do nothing on the deployed app.
        setLibrary((current) =>
          current ? { ...current, profile: payload.data.profile } : current,
        );
        setMessage({ tone: "info", text: "Client profile rebuilt." });
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    await fetch(`/api/client-emails?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await load();
  };

  const profile = library?.profile ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-5 py-6">
      <Card
        title="Client Voice & Knowledge"
        action={
          <Button onClick={() => void refreshProfile()} disabled={busy || (library?.count ?? 0) === 0}>
            Refresh client profile
          </Button>
        }
      >
        <p className="text-2xl font-semibold tracking-tight text-ink">
          {library?.count ?? 0} email example{(library?.count ?? 0) === 1 ? "" : "s"} loaded
        </p>
        <p className="mt-1 text-sm text-ink-subtle">
          These teach the system how the client writes and what they tend to notice in a funnel. They are never
          treated as evidence about a prospect&apos;s page.
        </p>
        {library && !library.storage.durable && (
          <div className="mt-3">
            <Notice tone="warn">
              Storage is <span className="font-mono">{library.storage.kind}</span>, which does not survive a
              restart. Set <span className="font-mono">KNOWLEDGE_STORE=file</span> locally, or wire the Sheets
              store before relying on this in production.
            </Notice>
          </div>
        )}
        {message && (
          <div className="mt-3">
            <Notice tone={message.tone}>{message.text}</Notice>
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Add emails">
          <textarea
            value={paste}
            onChange={(event) => setPaste(event.target.value)}
            rows={12}
            placeholder={
              "Paste one or more emails.\n\nSeparate them with a blank line or a --- line.\nA leading 'Subject:' line is picked up automatically."
            }
            className="w-full rounded-lg border border-line-strong px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => void addPasted()} disabled={busy || paste.trim() === ""}>
              Add emails
            </Button>
            <label className="cursor-pointer rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-ink-muted hover:bg-surface-sunken">
              Upload .txt / .csv
              <input
                type="file"
                multiple
                accept=".txt,.csv,text/plain,text/csv"
                className="hidden"
                onChange={(event) => {
                  if (event.target.files?.length) void upload(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
          </div>
        </Card>

        <Card title={`Library (${library?.count ?? 0})`}>
          {!library || library.emails.length === 0 ? (
            <Empty>No emails yet. Paste a few to get started.</Empty>
          ) : (
            <ul className="max-h-[26rem] divide-y divide-line overflow-y-auto">
              {library.emails.map((email) => (
                <li key={email.id} className="flex items-start gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    {email.subject && <p className="truncate text-sm font-medium text-ink">{email.subject}</p>}
                    <p className="line-clamp-2 text-xs text-ink-subtle">{email.preview}</p>
                    <p className="mt-0.5 text-[11px] text-ink-subtle">
                      {email.words} words · {email.source}
                    </p>
                  </div>
                  <Button variant="ghost" onClick={() => void remove(email.id)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {profile ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Writing profile">
            <dl className="grid grid-cols-2 gap-4">
              <Field label="Tone" value={profile.writing.tone} />
              <Field label="Vocabulary" value={profile.writing.vocabulary} />
              <Field label="Sentence style" value={profile.writing.sentence_style} />
              <Field label="Pacing" value={profile.writing.pacing} />
              <Field label="Greeting" value={profile.writing.greeting_style} />
              <Field label="Sign-off" value={profile.writing.sign_off_style} />
              <Field label="CTA style" value={profile.writing.cta_style} />
              <Field label="Emojis" value={String(profile.writing.uses_emojis ?? "unknown")} />
            </dl>
            <ListBlock label="Common phrases" values={profile.writing.common_phrases} />
            <ListBlock label="Avoids" values={profile.writing.avoided_phrases} />
          </Card>

          <Card title="Diagnostic & outreach profile">
            <ListBlock label="Issues this client notices" values={profile.diagnostic.issues_noticed} />
            <ListBlock label="Treats as commercially meaningful" values={profile.diagnostic.commercially_meaningful} />
            <div className="mt-3 space-y-3">
              <Field label="How they frame an issue" value={profile.diagnostic.framing} />
              <Field label="Issue to impact" value={profile.diagnostic.issue_to_impact} />
              <Field label="Observation to offer" value={profile.diagnostic.observation_to_offer} />
            </div>
            <p className="mt-4 border-t border-line pt-3 text-xs text-ink-subtle">
              Built from {profile.sampleCount} samples by{" "}
              <span className="font-mono">{profile.generatedBy}</span> on{" "}
              {new Date(profile.generatedAt).toLocaleString()}. These are habits, not findings — an issue only
              reaches an email when this funnel&apos;s own audit evidences it.
            </p>
          </Card>
        </div>
      ) : (
        <Card title="Client profile">
          <Empty>
            No profile yet. Add emails, then choose <span className="font-medium">Refresh client profile</span>.
          </Empty>
        </Card>
      )}
    </div>
  );
}

function ListBlock({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="mt-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">{label}</p>
      {values.length === 0 ? (
        <p className="mt-0.5 text-sm text-ink-subtle">—</p>
      ) : (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {values.map((value, index) => (
            <span key={index} className="rounded bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">
              {value}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
