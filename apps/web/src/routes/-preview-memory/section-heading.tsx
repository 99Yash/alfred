export function SectionHeading({
  title,
  count,
  hint,
}: {
  title: string;
  count?: number;
  hint?: string;
}) {
  return (
    <div className="space-y-1 px-1">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[15px] font-medium text-vs-fg-4">{title}</h2>
        {typeof count === "number" ? (
          <span className="text-xs text-vs-fg-2 tabular-nums">{count}</span>
        ) : null}
      </div>
      {hint ? <p className="text-xs text-vs-fg-3">{hint}</p> : null}
    </div>
  );
}
