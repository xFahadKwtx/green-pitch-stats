/** Visual-only marker for the Airtable "Double Points" checkbox. Never affects points. */
export function DoublePointsBadge({ active, label }: { active?: boolean | undefined; label: string }) {
  if (active !== true) return null;
  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      className="ms-1.5 inline-flex shrink-0 items-center gap-1 rounded-full border border-gold/50 bg-gold/15 px-2.5 py-1 align-middle font-display text-sm leading-none font-bold tracking-wide whitespace-nowrap text-gold normal-case sm:text-base"
    >
      <span aria-hidden="true">⚡</span>
      <span aria-hidden="true" dir="ltr">2X</span>
    </span>
  );
}
