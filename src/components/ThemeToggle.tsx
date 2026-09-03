"use client";

import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
export const THEME_KEY = "funnel-outreach-theme";

/**
 * The theme lives on <html>, not in React state.
 *
 * An inline script in the layout sets it before first paint, so by the time
 * React runs the value already exists in the DOM and React is the LATE reader.
 * useSyncExternalStore is the tool for exactly that shape — reading a store
 * React does not own — and it avoids both the hydration mismatch of guessing
 * during render and the cascading render of correcting it in an effect.
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/**
 * The server cannot know the answer — it is in the visitor's storage.
 *
 * "light" is the honest default rather than a guess: the pre-paint script has
 * already applied the real one to <html>, so the only frame this affects is
 * the server-rendered markup, which the browser corrects before it paints.
 */
function serverTheme(): Theme {
  return "light";
}

/**
 * Light or dark, remembered.
 *
 * Follows the system preference until someone states a preference; after that
 * the stated one wins and stops tracking the OS, because a toggle that
 * silently reverts is a broken toggle.
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, readTheme, serverTheme);

  const flip = (): void => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    /*
     * Cross-fade the swap, then take the transition back off.
     *
     * Left on permanently it would also animate every hover and focus state,
     * which have to be instant to feel responsive. 320ms covers the 260ms
     * transition with a little slack.
     */
    const root = document.documentElement;
    root.classList.add("theme-changing");
    window.setTimeout(() => root.classList.remove("theme-changing"), 320);
    root.dataset.theme = next;
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private browsing refuses storage. The toggle still works for this tab.
    }
    for (const listener of listeners) listener();
  };

  const goingDark = theme === "light";
  return (
    <button
      type="button"
      onClick={flip}
      aria-label={goingDark ? "Switch to dark theme" : "Switch to light theme"}
      title={goingDark ? "Dark theme" : "Light theme"}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink"
    >
      {/*
        One icon that morphs, not two that swap. The circle grows as the mask
        slides across it, so the sun becomes a moon in a single motion.
      */}
      <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" aria-hidden>
        <mask id="theme-toggle-mask">
          <rect x="0" y="0" width="20" height="20" fill="white" />
          <circle
            cx={goingDark ? 14 : 26}
            cy={goingDark ? 6 : 2}
            r="7"
            fill="black"
            className="transition-[cx,cy] duration-500 ease-out-soft"
          />
        </mask>
        <circle
          cx="10"
          cy="10"
          r={goingDark ? 5 : 7.5}
          fill="currentColor"
          mask="url(#theme-toggle-mask)"
          className="transition-[r] duration-500 ease-out-soft"
        />
        <g
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          className={`origin-center transition-all duration-500 ease-out-soft ${
            goingDark ? "scale-100 opacity-100" : "-rotate-45 scale-50 opacity-0"
          }`}
        >
          <path d="M10 1.5v1.6M10 16.9v1.6M18.5 10h-1.6M3.1 10H1.5M16 4l-1.1 1.1M5.1 14.9 4 16M16 16l-1.1-1.1M5.1 5.1 4 4" />
        </g>
      </svg>
    </button>
  );
}
