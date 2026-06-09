import * as Accordion from "@radix-ui/react-accordion";
import { ChevronRight, Loader2, Wrench } from "lucide-react";
import { useId, useState } from "react";
import { IntegrationGlyph, type IntegrationBrand } from "~/lib/integration-icons";
import { getIntegrationProvider } from "~/lib/integrations";
import { cn } from "~/lib/utils";
import { presentTool, ToolCallCard, type ToolCallView } from "./tool-call-card";

const ITEM = "tools";

/** Human provider name for a tool's scope, or null for system / unscoped tools. */
function providerLabel(tool: ToolCallView): string | null {
  const slug = tool.toolName.includes(".")
    ? tool.toolName.slice(0, tool.toolName.indexOf("."))
    : "";
  if (!slug || slug === "system") return null;
  if (slug === "web") return "the web";
  return getIntegrationProvider(slug)?.name ?? null;
}

/** Distinct integration glyphs touched across the run, in first-seen order. */
function runBrands(tools: ToolCallView[]): IntegrationBrand[] {
  const brands: IntegrationBrand[] = [];
  for (const tool of tools) {
    const { brand } = presentTool(tool);
    if (brand && !brands.includes(brand)) brands.push(brand);
  }
  return brands;
}

/**
 * One-line headline for a finished run: lead with the service(s) Alfred
 * touched, then the step count. "GitHub · 3 steps", "Gmail & GitHub · 5 steps",
 * "3 sources · 7 steps", or a neutral "Worked on it · N steps" when nothing
 * maps to a known provider.
 */
function runSummary(tools: ToolCallView[]): string {
  const heads: string[] = [];
  for (const tool of tools) {
    const label = providerLabel(tool);
    if (label && !heads.includes(label)) heads.push(label);
  }
  let head: string;
  if (heads.length === 0) head = "Worked on it";
  else if (heads.length === 1) head = heads[0]!;
  else if (heads.length === 2) head = `${heads[0]} & ${heads[1]}`;
  else head = `${heads.length} sources`;
  const n = tools.length;
  return `${head} · ${n} ${n === 1 ? "step" : "steps"}`;
}

/**
 * A turn's tool calls, folded into a single collapsible row so a long agentic
 * sequence doesn't bury the reply under a wall of steps. The group stays
 * collapsed by default — while the turn runs the trigger shows a spinner and
 * the current step's shimmering label; once it lands it settles to a quiet
 * summary ("GitHub · 3 steps") with the integration glyphs touched. Expanding
 * reveals the full timeline (the same light rows used everywhere else). A
 * single-tool turn skips the wrapper entirely — there's nothing to summarize.
 */
export function ToolCallGroup({ tools, active }: { tools: ToolCallView[]; active: boolean }) {
  const contentId = useId();
  const [value, setValue] = useState("");

  if (tools.length === 0) return null;
  if (tools.length === 1) return <ToolCallCard tool={tools[0]!} />;

  const last = tools[tools.length - 1]!;
  const runningLabel = last.status === "started" ? presentTool(last).running : "Working on it";
  const anyFailed = tools.some((t) => t.status === "failed");
  const brands = runBrands(tools);

  return (
    <Accordion.Root
      type="single"
      collapsible
      value={value}
      onValueChange={setValue}
      className="animate-chat-in w-full"
    >
      <Accordion.Item value={ITEM}>
        <Accordion.Header>
          <Accordion.Trigger
            aria-controls={contentId}
            className={cn(
              "group/tools -mx-2 flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px]",
              "transition-colors duration-150 hover:bg-app-bg-a2 outline-none",
            )}
          >
            {active ? (
              <span
                aria-hidden
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-app-bg-2"
              >
                <Loader2 size={13} className="animate-spin text-app-fg-3" />
              </span>
            ) : (
              <BrandCluster brands={brands} />
            )}
            <span
              className={cn(
                "min-w-0 truncate font-medium",
                active ? "animate-chat-shimmer-mask text-app-fg-4" : "text-app-fg-4",
              )}
            >
              {active ? runningLabel : runSummary(tools)}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {!active && anyFailed ? (
                <>
                  <span className="sr-only">Some steps failed</span>
                  <span aria-hidden className="size-1.5 rounded-full bg-app-red-4" />
                </>
              ) : null}
              <ChevronRight
                size={14}
                aria-hidden
                className="text-app-fg-2 transition-transform duration-200 group-data-[state=open]/tools:rotate-90"
              />
            </span>
          </Accordion.Trigger>
        </Accordion.Header>
        <Accordion.Content
          id={contentId}
          className="overflow-hidden data-[state=closed]:animate-chat-accordion-up data-[state=open]:animate-chat-accordion-down"
        >
          <div className="ml-3 mt-1.5 flex max-h-80 flex-col gap-1.5 overflow-y-auto overscroll-contain border-l-2 border-app-fg-a1 pl-3">
            {tools.map((tool) => (
              <ToolCallCard key={tool.toolCallId} tool={tool} />
            ))}
          </div>
        </Accordion.Content>
      </Accordion.Item>
    </Accordion.Root>
  );
}

/** Overlapping integration logos for the services a run touched (max 3 shown). */
function BrandCluster({ brands }: { brands: IntegrationBrand[] }) {
  if (brands.length === 0) {
    return (
      <span
        aria-hidden
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-app-bg-2"
      >
        <Wrench size={13} className="text-app-fg-3" />
      </span>
    );
  }
  return (
    <span aria-hidden className="flex shrink-0 items-center">
      {brands.slice(0, 3).map((brand, i) => (
        <span
          key={brand}
          className={cn(
            "inline-flex size-6 items-center justify-center rounded-md bg-app-bg-2 ring-1 ring-app-background",
            i > 0 && "-ml-2",
          )}
        >
          <IntegrationGlyph brand={brand} size={14} />
        </span>
      ))}
    </span>
  );
}
