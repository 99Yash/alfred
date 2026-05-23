import { ChevronRight, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "~/lib/utils";

export function ThoughtRow({
  duration,
  children,
  defaultOpen = false,
}: {
  duration: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "group/th flex items-center gap-2 text-sm leading-5",
          "outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        )}
      >
        <span
          aria-hidden
          className="size-6 shrink-0 inline-flex items-center justify-center rounded-md bg-vs-bg-2 text-vs-fg-3"
        >
          <Sparkles size={12} />
        </span>
        <span className="text-vs-fg-3">
          Thought for <span className="text-vs-fg-4 font-medium">{duration}</span>
        </span>
        <ChevronRight
          size={12}
          aria-hidden
          className={cn(
            "shrink-0 text-vs-fg-2 transition-transform duration-200",
            open && "rotate-90",
          )}
        />
      </button>
      {open ? (
        <p className="ml-8 mt-1.5 max-w-[64ch] text-xs leading-5 text-vs-fg-3">{children}</p>
      ) : null}
    </div>
  );
}
