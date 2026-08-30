"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Clears the session cookie server-side, then reloads into the login page. */
export function SignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void fetch("/api/auth/logout", { method: "POST" }).finally(() => {
          router.push("/login");
          // The cookie is gone but the router still holds rendered payloads
          // from the signed-in session; refresh discards them.
          router.refresh();
        });
      }}
      className="rounded-md px-2.5 py-1.5 text-sm font-medium text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink disabled:opacity-60"
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
