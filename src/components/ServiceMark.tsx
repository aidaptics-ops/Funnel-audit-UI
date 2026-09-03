/**
 * A small mark per connected service.
 *
 * Drawn inline rather than fetched. A remote logo is a third-party request on
 * every page load, a CSP entry, and a broken square the day the CDN moves it —
 * and these are 16px glyphs where the shape carries the recognition, not the
 * detail. Each one inherits currentColor, so it works in both themes without a
 * second asset.
 *
 * The name is not written beside the mark; it is the tooltip and the accessible
 * label. Four names in a row is a list to read, four marks is a row to scan.
 */
export type ServiceMarkId = "anthropic" | "hunter" | "rocketreach" | "neverbounce" | "sheets" | "voice";

export function ServiceMark({ id, className = "h-4 w-4" }: { id: ServiceMarkId; className?: string }) {
  const shared = { className, viewBox: "0 0 24 24", "aria-hidden": true as const };

  switch (id) {
    // Anthropic's mark: the splayed burst, simplified to three strokes.
    case "anthropic":
      return (
        <svg {...shared} fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
          <path d="M7.5 20 12 4l4.5 16M4 13.5h7.2" />
        </svg>
      );

    // Hunter: a target reticle — it finds a specific person at a domain.
    case "hunter":
      return (
        <svg {...shared} fill="none" stroke="currentColor" strokeWidth="1.9">
          <circle cx="12" cy="12" r="7.2" />
          <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
          <path d="M12 1.9v3.2M12 18.9v3.2M22.1 12h-3.2M5.1 12H1.9" strokeLinecap="round" />
        </svg>
      );

    // RocketReach: a rocket, nose up.
    case "rocketreach":
      return (
        <svg {...shared} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round">
          <path d="M12 2.2c3.1 2.4 4.7 5.8 4.7 9.4l-1.9 4.6H9.2l-1.9-4.6C7.3 8 8.9 4.6 12 2.2Z" />
          <path d="M9.2 16.2 6.6 21l3.1-1.4M14.8 16.2 17.4 21l-3.1-1.4" strokeLinecap="round" />
          <circle cx="12" cy="10" r="1.7" fill="currentColor" stroke="none" />
        </svg>
      );

    // NeverBounce: an envelope with a tick — the address is deliverable.
    case "neverbounce":
      return (
        <svg {...shared} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round">
          <path d="M2.9 6.6h13.4v7.6M2.9 6.6l6.7 5 3.1-2.3M2.9 6.6v10.8h9.4" strokeLinecap="round" />
          <path d="m14.9 18.2 2.4 2.4 4.2-5.2" strokeLinecap="round" />
        </svg>
      );

    // Sheets: a grid.
    case "sheets":
      return (
        <svg {...shared} fill="none" stroke="currentColor" strokeWidth="1.9">
          <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="2.4" />
          <path d="M3.4 9.6h17.2M3.4 15.2h17.2M9.6 3.4v17.2" />
        </svg>
      );

    // Client voice: a quotation mark — the samples the email is written from.
    case "voice":
      return (
        <svg {...shared} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round">
          <path d="M9.4 5.6c-3 1.3-4.8 3.9-4.8 7.2 0 2.9 1.6 4.8 3.9 4.8 1.9 0 3.3-1.3 3.3-3.2 0-1.8-1.2-3.1-2.9-3.1-.4 0-.8.1-1 .2.3-1.6 1.4-2.9 3-3.6ZM19.4 5.6c-3 1.3-4.8 3.9-4.8 7.2 0 2.9 1.6 4.8 3.9 4.8 1.9 0 3.3-1.3 3.3-3.2 0-1.8-1.2-3.1-2.9-3.1-.4 0-.8.1-1 .2.3-1.6 1.4-2.9 3-3.6Z" />
        </svg>
      );
  }
}
