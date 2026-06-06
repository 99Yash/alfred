import { Plug, Plus } from "lucide-react";
import { AppCard } from "~/components/ui/v2";
import { MCP_SECTION } from "./helpers";

export function MCPServerSection() {
  return (
    <section className="space-y-3 app-card-in" style={{ animationDelay: `${480}ms` }}>
      <h2 className="text-xs uppercase tracking-tight text-app-fg-2 font-medium px-1">
        {MCP_SECTION.heading}
      </h2>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        <AppCard
          padded={false}
          aria-disabled
          className="flex items-center gap-3 px-3 py-2.5 opacity-70 cursor-not-allowed"
        >
          <span
            className="grid size-9 shrink-0 place-items-center rounded-xl bg-app-bg-2 ring-1 ring-app-bg-3 text-app-fg-3"
            aria-hidden
          >
            <Plug size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-app-fg-4">{MCP_SECTION.name}</p>
            <p className="truncate text-xs text-app-fg-3">{MCP_SECTION.description}</p>
          </div>
          <span className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-lg bg-app-bg-2 px-2.5 text-xs font-medium text-app-fg-2">
            <Plus size={12} />
            Add
          </span>
        </AppCard>
      </div>
    </section>
  );
}
