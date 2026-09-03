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
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/*
          Applied BEFORE first paint, which is the whole point.
          
          React cannot do this: the server has no window, so the first painted
          frame would be light and a dark-mode user would get a white flash on
          every navigation. Reading storage in a blocking inline script is the
          only way the correct theme is on <html> before the browser paints.
          suppressHydrationWarning above covers the attribute this adds, which
          the server could not have rendered.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem("funnel-outreach-theme");var d=s?s==="dark":matchMedia("(prefers-color-scheme: dark)").matches;if(d)document.documentElement.dataset.theme="dark";}catch(e){}})()`,
          }}
        />
      </head>
      <body className="min-h-screen">
        {/* Reads the environment on the server; the header decides visibility. */}
        <SiteHeader authConfigured={isAuthConfigured()} />
        <main>{children}</main>
      </body>
    </html>
  );
}
