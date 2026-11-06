/** Visual-only marker for the Airtable "Double Points" checkbox. Never affects points. */
export function DoublePointsBadge({ active, label }: { active?: boolean; label: string }) {
  if (active !== true) return null;
  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      className="ms-1.5 inline-flex shrink-0 items-center gap-0.5 rounded-full border border-gold/50 bg-gold/15 px-1.5 py-0.5 align-middle font-display text-[10px] leading-none font-bold tracking-wide whitespace-nowrap text-gold normal-case sm:text-xs"
    >
      <span aria-hidden="true">⚡</span>
      <span aria-hidden="true" dir="ltr">2X</span>
    </span>
  );
}
