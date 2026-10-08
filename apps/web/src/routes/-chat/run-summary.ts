import { type LucideIcon } from "lucide-react";
import { type IntegrationBrand } from "~/lib/integrations/integration-icons";
import { lowerFirst } from "~/lib/strings";
import { brandlessToolIcon } from "./animated-tool-icons";
import { presentTool, toolCategory, type ToolCallView } from "./tool-call-presentation";

// Run summary for `ToolCallGroup` and `SubAgentCard`. Its own module to avoid a cycle between them.

/** One coin: an integration brand tile or a system mark. */
export type RunGlyph =
  | { kind: "brand"; key: string; brand: IntegrationBrand }
  | { kind: "icon"; key: string; Icon: LucideIcon };

/** Distinct glyphs a run touched, in first-seen order: the brand coin, else the tool's own mark. */
export function runGlyphs(tools: ToolCallView[]): RunGlyph[] {
  const glyphs: RunGlyph[] = [];
  const seenBrands = new Set<IntegrationBrand>();
  // Dedupe by icon, not name: several tools share one mark.
  const seenIcons = new Set<LucideIcon>();

  for (const tool of tools) {
    const { brand } = presentTool(tool);

    if (brand) {
      if (seenBrands.has(brand)) continue;
      seenBrands.add(brand);
      glyphs.push({ kind: "brand", key: brand, brand });
      continue;
    }

    const Icon = brandlessToolIcon(tool.toolName);

    if (Icon) {
      if (seenIcons.has(Icon)) continue;
      seenIcons.add(Icon);
      // The first tool name per mark is unique, so it is a stable key.
      glyphs.push({ kind: "icon", key: tool.toolName, Icon });
    }
  }

  return glyphs;
}

/**
 * Headline for a finished run, e.g. "Checked your calendar", "Searched multiple sources",
 * "Finished N actions", or reads and writes joined. Plumbing is not counted.
 * Only steps that landed count, so a failed read never reads as done.
 */
export function runSummary(tools: ToolCallView[]): string {
  const succeeded = tools.filter((t) => t.status === "succeeded");
  const sources = succeeded.filter((t) => toolCategory(t.toolName) === "source");
  const actions = succeeded.filter((t) => toolCategory(t.toolName) === "action");

  const distinctSources = new Set(sources.map((t) => t.toolName));

  const sourceClause =
    sources.length === 0
      ? null
      : distinctSources.size === 1
        ? presentTool(sources[0]!).done
        : "Searched multiple sources";

  const actionClause =
    actions.length === 0
      ? null
      : actions.length === 1
        ? presentTool(actions[0]!).done
        : `Finished ${actions.length} actions`;

  if (sourceClause && actionClause) {
    return `${sourceClause} and ${lowerFirst(actionClause)}`;
  }

  const lone = actionClause ?? sourceClause;

  if (lone) return lone;

  // Nothing landed: say so if a step failed; else it was only plumbing.
  return tools.some((t) => t.status === "failed") ? "Couldn't finish that" : "Worked on it";
}
