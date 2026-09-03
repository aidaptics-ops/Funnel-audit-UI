/**
 * The mark and the name, in one place.
 *
 * Defined once because the header and the login page were drawing their own —
 * three descending bars on one, a letter in a coloured square on the other —
 * so the first thing anyone saw of the product disagreed with the rest of it.
 *
 * Three bars stepping down read as a funnel and belong to this tool. A letter
 * in a tinted box is the most template-looking thing a dashboard can carry.
 */
export function Wordmark({ size = "sm" }: { size?: "sm" | "lg" }) {
  const large = size === "lg";
  const bar = large ? "h-[4px]" : "h-[3px]";
  const gap = large ? "gap-[4px]" : "gap-[3px]";
  const widths = large ? ["w-[26px]", "w-[17px]", "w-[9px]"] : ["w-[18px]", "w-[12px]", "w-[6px]"];

  return (
    <span className={`flex items-center ${large ? "gap-3" : "gap-2.5"}`}>
      <span aria-hidden className={`flex flex-col items-center ${gap}`}>
        <span className={`block ${bar} ${widths[0]} rounded-full bg-ink transition-colors group-hover:bg-accent`} />
        <span className={`block ${bar} ${widths[1]} rounded-full bg-ink/55 transition-colors group-hover:bg-accent/70`} />
        <span className={`block ${bar} ${widths[2]} rounded-full bg-ink/30 transition-colors group-hover:bg-accent/45`} />
      </span>
      <span
        className={`font-semibold tracking-[-0.019em] text-ink ${large ? "text-[19px]" : "text-[15px]"}`}
      >
        Funnel Outreach
      </span>
    </span>
  );
}
