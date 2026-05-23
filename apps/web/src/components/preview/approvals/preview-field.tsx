import { cn } from "~/lib/utils";

export function PreviewField({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  const display = value.trim() || "—";
  return (
    <div className={cn(multiline && "sm:col-span-2")}>
      <p className="text-[11px] font-medium uppercase tracking-tight text-vs-fg-2">{label}</p>
      <p
        className={cn(
          "mt-1 break-words text-xs leading-5 text-vs-fg-4",
          multiline && "max-h-40 overflow-auto whitespace-pre-wrap",
        )}
      >
        {display}
      </p>
    </div>
  );
}
