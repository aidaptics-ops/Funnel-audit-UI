"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, Notice } from "@/components/ui";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: { message: string };
      };
      if (!payload.ok) {
        setError(payload.error?.message ?? "Could not sign in.");
        setBusy(false);
        return;
      }
      // A full navigation, not a client push: the cookie has just been set and
      // every page behind the gate must be re-fetched with it.
      window.location.href = params.get("next") ?? "/";
    } catch {
      setError("Could not reach the server.");
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-base font-bold text-white">
            F
          </div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">Funnel Outreach Console</h1>
          <p className="mt-1 text-[13px] text-ink-subtle">Sign in to continue.</p>
        </div>

        <form
          onSubmit={submit}
          className="rounded-panel border border-line bg-surface p-5 shadow-panel"
          suppressHydrationWarning
        >
          {error && (
            <div className="mb-4">
              <Notice tone="error">{error}</Notice>
            </div>
          )}

          <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-subtle" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13px] text-ink focus:border-accent focus:outline-none"
          />

          <label
            className="mt-4 block text-[11px] font-semibold uppercase tracking-wider text-ink-subtle"
            htmlFor="password"
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13px] text-ink focus:border-accent focus:outline-none"
          />

          <div className="mt-5">
            <Button type="submit" full disabled={busy || !email || !password}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </div>
        </form>

        <p className="mt-4 text-center text-xs leading-relaxed text-ink-subtle">
          This console holds funnel data, client information and analysis results.
        </p>
      </div>
    </div>
  );
}
