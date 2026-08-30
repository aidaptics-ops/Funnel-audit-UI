import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { SiteHeader } from "@/components/SiteHeader";
import { isAuthConfigured } from "@/lib/auth/session";
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
        {/* Reads the environment on the server; the header decides visibility. */}
        <SiteHeader authConfigured={isAuthConfigured()} />
        <main>{children}</main>
      </body>
    </html>
  );
}
