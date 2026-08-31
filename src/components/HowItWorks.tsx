"use client";

import { useState } from "react";
import { Modal } from "./Modal";

/**
 * What this tool actually does, for someone opening it for the first time.
 *
 * Written in terms of what the operator gets at each step, not what the system
 * runs. The one thing it insists on is that a step can legitimately find
 * nothing — plenty of ad funnels are deliberately anonymous — because a person
 * who does not know that reads an empty result as a broken tool.
 */
const STEPS = [
  {
    title: "Add a funnel URL",
    body: "Paste one link or a whole list. Each page is loaded and read the way a visitor would see it — the headline, the form, the calls to action, what is above the fold.",
  },
  {
    title: "Find the business and its owner",
    body: "The business name is taken from the page itself, usually the footer. From there the open web is searched for whoever founded or runs it, and every claim has to come with a source.",
  },
  {
    title: "Find and verify the emails",
    body: "Hunter, RocketReach and the open web are searched together for addresses belonging to that person. Each one is checked against the real mail server before it is offered.",
  },
  {
    title: "Approve a contact",
    body: "Every address found is listed with where it came from and whether it is confirmed. You pick the one to use. Nothing is chosen for you, and the others stay available if you change your mind.",
  },
  {
    title: "Review the email",
    body: "An outreach email is written from what was actually observed on the page, in the client's own voice. Anything it could not evidence is flagged rather than invented.",
  },
];

export function HowItWorks() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M6.2 6.1a1.85 1.85 0 1 1 2.2 2.15v1"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <circle cx="8.4" cy="11.3" r="0.75" fill="currentColor" />
        </svg>
        How it works
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        width="md"
        title="How it works"
        subtitle="From a funnel URL to an email you can send, in five steps."
      >
        <ol className="space-y-1">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-4">
              {/* The rail: a number, and a line joining it to the next step. */}
              <div className="flex flex-col items-center">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent ring-1 ring-line-accent/40">
                  {index + 1}
                </span>
                {index < STEPS.length - 1 && <span className="mt-1 w-px flex-1 bg-line" aria-hidden />}
              </div>

              <div className={index < STEPS.length - 1 ? "pb-6" : ""}>
                <p className="text-[14px] font-semibold text-ink">{step.title}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-2 rounded-lg border border-line bg-surface-sunken px-4 py-3">
          <p className="text-[13px] font-semibold text-ink">Finding nothing is a real answer</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
            Many advertising funnels are deliberately anonymous. When the owner or a verified address cannot be
            established, that is reported plainly rather than guessed at — a wrong name in a cold email is worse
            than no name, and a guessed address bounces. You can always enter one yourself.
          </p>
        </div>
      </Modal>
    </>
  );
}
