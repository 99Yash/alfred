import { faviconFor } from "~/lib/favicon";
import { cn } from "~/lib/utils";
import type { Source } from "./sources";

/**
 * A quiet "where this came from" footer under an assistant reply: the favicon +
 * domain of every site the turn's web search drew on, deduped to one chip per
 * site (the browser-tab read the user already knows). The precise per-claim
 * links stay inline as citation pills; this strip is the at-a-glance source
 * list. Each chip staggers in, lifts on hover, and presses on click.
 */
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
          // `backwards` holds the hidden `from` frame through the stagger delay
          // — the shared `chat-in` keyframe sets no fill-mode, so without this a
          // delayed chip would flash in fully then snap back to start.
          style={{ animationDelay: `${i * 40}ms`, animationFillMode: "backwards" }}
          className={cn(
            "animate-chat-in group/source inline-flex items-center gap-1.5",
            "rounded-lg border border-app-bg-3/50 bg-app-bg-a1 py-1 pl-1.5 pr-2",
            "text-xs text-app-fg-3 no-underline",
            "transition-[background-color,color,translate,box-shadow] duration-150",
            "hover:-translate-y-px hover:bg-app-bg-a2 hover:text-app-fg-4 hover:shadow-sm",
            "active:translate-y-0 active:scale-[0.96]",
            "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-3",
          )}
        >
          <span className="grid size-4 shrink-0 place-items-center overflow-hidden rounded-[4px] ring-1 ring-inset ring-white/10">
            <img
              src={faviconFor(source.faviconDomain)}
              alt=""
              aria-hidden
              loading="lazy"
              className="size-full object-cover"
            />
          </span>
          <span className="max-w-[22ch] truncate">{source.label}</span>
        </a>
      ))}
    </div>
  );
}
