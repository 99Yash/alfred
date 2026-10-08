import { cn } from "~/lib/utils";
import { Favicon } from "./favicon";
import type { Source } from "./sources";

/** Favicon chips for the sites a turn's web search used, one per site. */
export function SourcesStrip({ sources }: { sources: Source[] }) {
  if (sources.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sources.map((source, i) => (
        <a
          key={source.faviconDomain}
          href={source.href}
          target="_blank"
          rel="noreferrer noopener"
          // `chat-in` sets no fill-mode, so `backwards` keeps the chip hidden during its delay.
          style={{ animationDelay: `${i * 40}ms`, animationFillMode: "backwards" }}
          className={cn(
            "animate-chat-in group/source inline-flex items-center gap-1.5",
            "rounded-lg border border-app-bg-3/50 bg-app-bg-a1 py-1 pr-2 pl-1.5",
            "text-xs text-app-fg-3 no-underline",
            "transition-[background-color,color,translate,box-shadow] duration-150",
            "hover:-translate-y-px hover:bg-app-bg-a2 hover:text-app-fg-4 hover:shadow-sm",
            "active:translate-y-0 active:scale-[0.96]",
            "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-3",
          )}
        >
          <Favicon domain={source.faviconDomain} size={16} />
          <span className="max-w-[22ch] truncate">{source.label}</span>
        </a>
      ))}
    </div>
  );
}
