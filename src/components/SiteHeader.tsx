"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOut } from "./SignOut";
import { HowItWorks } from "./HowItWorks";
import { ThemeToggle } from "./ThemeToggle";
import { Wordmark } from "./Wordmark";

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
    <header className="sticky top-0 z-10 border-b border-line bg-canvas/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1400px] items-center gap-8 px-6 py-3">
        {/*
          A mark, not a letter in a coloured square. The tinted-box-with-an-
          initial is the single most template-looking element a dashboard can
          carry; three descending bars read as a funnel and belong to this tool
          rather than to every tool.
        */}
        <Link href="/" className="group flex items-center">
          <Wordmark />
        </Link>

        <nav className="flex items-center gap-0.5 text-sm">
          <NavLink href="/" active={pathname === "/"}>
            Funnels
          </NavLink>
          <NavLink href="/runs" active={pathname.startsWith("/runs")}>
            Runs
          </NavLink>
          <NavLink href="/expenditure" active={pathname.startsWith("/expenditure")}>
            Expenditure
          </NavLink>
          <NavLink href="/client-voice" active={pathname.startsWith("/client-voice")}>
            Client Voice
          </NavLink>
        </nav>

        <div className="ml-auto flex items-center gap-1">
          <HowItWorks />
          <ThemeToggle />
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
      // The active tab is stated by weight and ink, not by a tinted pill. Four
      // pills in a row read as four buttons; one darker label reads as where
      // you are.
      className={`relative rounded-md px-2.5 py-1.5 transition-colors ${
        active
          ? "font-semibold text-ink after:absolute after:inset-x-2.5 after:-bottom-[13px] after:h-[2px] after:rounded-full after:bg-ink after:content-['']"
          : "font-medium text-ink-subtle hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}
