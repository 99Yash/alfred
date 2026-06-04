import { Plus } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";

const WRAPPER = cn(
  "group w-full rounded-xl px-2 py-2 -mx-0.5",
  "border border-dashed border-white/15 hover:border-white/35 focus-within:border-white/35",
  "transition-colors flex items-center gap-2",
);

/**
 * Add-a-todo row. When `onSubmit` is wired (live rail), it's an inline input
 * that creates a todo on Enter; without it (fixture previews), a static
 * affordance. Empty/whitespace submits are ignored.
 */
export function RailAddRow({
  placeholder,
  onSubmit,
}: {
  placeholder: string;
  onSubmit?: (value: string) => void;
}) {
  const [value, setValue] = useState("");

  if (!onSubmit) {
    return (
      <button
        type="button"
        className={cn(
          WRAPPER,
          "text-left outline-none focus-visible:ring-2 focus-visible:ring-white/40",
        )}
      >
        <Plus
          size={12}
          aria-hidden
          className="text-white/60 group-hover:text-white transition-colors"
        />
        <span className="text-[12px] text-white/65 group-hover:text-white/90 transition-colors">
          {placeholder}
        </span>
      </button>
    );
  }

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue("");
  };

  return (
    <div className={WRAPPER}>
      <Plus
        size={12}
        aria-hidden
        className="shrink-0 text-white/60 group-focus-within:text-white transition-colors"
      />
      <input
        type="text"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-[12px] text-white outline-none",
          "placeholder:text-white/65",
        )}
      />
    </div>
  );
}
