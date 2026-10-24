import { Plus } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";

const WRAPPER = cn(
  "group -mx-0.5 w-full rounded-surface p-2",
  "border border-dashed border-app-bg-a4 focus-within:border-app-fg-a1 hover:border-app-fg-a1",
  "flex items-center gap-2 transition-colors",
);

/** An input that adds a todo on Enter when `onSubmit` is set; else static. Blank submits are ignored. */
export function RailAddRow({
  placeholder,
  onSubmit,
}: {
  placeholder: string;
  onSubmit?: ((value: string) => void) | undefined;
}) {
  const [value, setValue] = useState("");

  if (!onSubmit) {
    return (
      <button
        type="button"
        className={cn(
          WRAPPER,
          "text-left outline-none focus-visible:ring-2 focus-visible:ring-app-fg-a2",
        )}
      >
        <Plus
          size={12}
          aria-hidden
          className="text-app-fg-a3 transition-colors group-hover:text-app-fg-4"
        />
        <span className="text-[12px] text-app-fg-a3 transition-colors group-hover:text-app-fg-a4">
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
        className="shrink-0 text-app-fg-a3 transition-colors group-focus-within:text-app-fg-4"
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
          "min-w-0 flex-1 bg-transparent text-[12px] text-app-fg-4 outline-none",
          "placeholder:text-app-fg-a3",
        )}
      />
    </div>
  );
}
