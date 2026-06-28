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
          "outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
        )}
      >
        <span
          aria-hidden
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-app-bg-2 text-app-fg-3"
        >
          <Sparkles size={12} />
        </span>
        <span className="text-app-fg-3">
          Thought for <span className="font-medium text-app-fg-4">{duration}</span>
        </span>
        <ChevronRight
          size={12}
          aria-hidden
          className={cn(
            "shrink-0 text-app-fg-2 transition-transform duration-200",
            open && "rotate-90",
          )}
        />
      </button>
      {open ? (
        <p className="mt-1.5 ml-8 max-w-[64ch] text-xs leading-5 text-app-fg-3">{children}</p>
      ) : null}
    </div>
  );
}
