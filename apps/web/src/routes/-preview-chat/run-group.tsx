import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "~/lib/utils";

export function RunGroup({
  title,
  itemCount,
  defaultOpen = true,
  children,
}: {
  title: string;
  itemCount?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="-mx-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "group/run flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        )}
      >
        <ChevronRight
          size={14}
          aria-hidden
          className={cn(
            "shrink-0 text-vs-fg-2 transition-transform duration-200",
            open && "rotate-90",
          )}
        />
        <span className="text-sm font-medium text-vs-fg-4">{title}</span>
        {typeof itemCount === "number" ? (
          <span className="ml-auto text-xs text-vs-fg-2 tabular-nums">
            {itemCount} {itemCount === 1 ? "step" : "steps"}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="relative ml-[7px] mt-1.5 pl-5 pb-1">
          <span
            aria-hidden
            className="absolute left-0 top-1.5 bottom-2.5 w-px bg-vs-bg-3"
          />
          <div className="space-y-1.5">{children}</div>
        </div>
      ) : null}
    </div>
  );
}
