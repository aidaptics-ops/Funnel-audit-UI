"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOut } from "./SignOut";
import { HowItWorks } from "./HowItWorks";

/**
 * The header, which only exists for someone who is signed in.
 *
 * It hides itself on the login page. That is not a guess at auth state: the
 * Proxy gate makes every other route unreachable without a session, so "not on
 * /login" and "signed in" are the same condition. Showing the bar there would
 * offer Sign Out to someone who is not signed in, and three nav links that
 * bounce straight back to this page.
 */
export function SiteHeader({ authConfigured }: { authConfigured: boolean }) {
  const pathname = usePathname();
  if (pathname === "/login") return null;

  return (
    <header className="sticky top-0 z-10 border-b border-line bg-surface/85 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] items-center gap-8 px-6 py-3.5">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-[13px] font-bold text-white">
            F
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink">Funnel Outreach</span>
        </Link>

        <nav className="flex items-center gap-1 text-sm">
          <NavLink href="/" active={pathname === "/"}>
            Funnels
          </NavLink>
          <NavLink href="/runs" active={pathname.startsWith("/runs")}>
            Runs
          </NavLink>
          <NavLink href="/client-voice" active={pathname.startsWith("/client-voice")}>
            Client Voice
          </NavLink>
        </nav>

        <div className="ml-auto flex items-center gap-1">
          <HowItWorks />
          {authConfigured && <SignOut />}
        </div>
      </div>
    </header>
  );
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-md px-2.5 py-1.5 font-medium transition-colors ${
        active ? "bg-accent-soft text-accent" : "text-ink-muted hover:bg-surface-sunken hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}
