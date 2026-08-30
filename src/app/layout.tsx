import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";

// The scaffold referenced --font-geist-sans without ever defining it, which
// silently fell back to Arial. This defines the variable globals.css expects.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Funnel Outreach Console",
  description: "Audit a funnel, then write the outreach email in the client's own voice.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen">
        <header className="sticky top-0 z-10 border-b border-line bg-surface/85 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-8 px-6 py-3.5">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-[13px] font-bold text-white">
                F
              </span>
              <span className="text-[15px] font-semibold tracking-tight text-ink">Funnel Outreach</span>
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              <NavLink href="/">Funnels</NavLink>
              <NavLink href="/runs">Runs</NavLink>
              <NavLink href="/client-voice">Client Voice</NavLink>
            </nav>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-2.5 py-1.5 font-medium text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
    >
      {children}
    </Link>
  );
}
