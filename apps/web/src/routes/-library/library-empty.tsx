import { PartyPopper } from "lucide-react";
import type { ReactNode } from "react";

export function LibraryEmpty({ query }: { query: string }): ReactNode {
  const isSearching = query.trim().length > 0;
  const title = isSearching ? "No matches" : "No recent artifacts";
  const description = isSearching
    ? `No artifacts match "${query}".`
    : "Generated documents and pages will appear here once Alfred starts producing them.";

  return (
    <div className="grid min-h-[280px] place-items-center text-center">
      <div className="flex flex-col items-center">
        <span
          aria-hidden
          className="grid size-12 place-items-center rounded-2xl bg-app-bg-2 text-app-fg-3"
        >
          <PartyPopper size={22} strokeWidth={1.5} />
        </span>
        <p className="mt-3 text-sm font-medium text-app-fg-4">{title}</p>
        <p className="mt-1 max-w-[28rem] text-[12.5px] leading-relaxed text-app-fg-3">
          {description}
        </p>
      </div>
    </div>
  );
}
