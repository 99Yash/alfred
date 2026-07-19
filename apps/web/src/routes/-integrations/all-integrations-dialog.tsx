import { Search } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent } from "~/components/ui/dialog";
import { AppInput } from "~/components/ui/v2";
import { MCPServerSection } from "./mcp-server-section";
import { SectionBlock } from "./section-block";
import { useIntegrationCatalog } from "./use-integration-catalog";

/**
 * The "Connect your tools" overlay: the full integration catalog — search,
 * a floating Connected section, category sections, and MCP — dropped into a
 * dialog so the chat empty-state can surface it without leaving the page.
 * Mirrors dimension's `AllIntegrationsDialog`, re-tokenized onto Alfred's
 * frost material and driven by the same `useIntegrationCatalog` the full
 * `/integrations` page uses. Selecting a tile routes to its detail page,
 * which unmounts the chat route (and this dialog) along the way.
 */
export function AllIntegrationsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const { sections, mcpVisible, empty } = useIntegrationCatalog(query);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="All Integrations"
        description="Connect the tools Alfred can read, write, and act on."
        className="max-w-3xl"
      >
        <div className="scroll-stable max-h-[70vh] space-y-6 overflow-y-auto px-6 pt-2 pb-6">
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-app-fg-2"
            />
            <AppInput
              placeholder="Search for integration"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="!h-[44px] w-full !rounded-2xl !pl-10"
              aria-label="Search integrations"
            />
          </div>

          <div className="space-y-8">
            {sections.map((section, sIdx) => (
              <SectionBlock key={section.title} section={section} index={sIdx} />
            ))}
            {mcpVisible ? <MCPServerSection /> : null}
            {empty ? (
              <p className="text-center text-sm text-app-fg-3">
                No integrations match &ldquo;{query}&rdquo;.
              </p>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
