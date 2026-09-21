import { type LucideIcon } from "lucide-react";
import { type IntegrationBrand } from "~/lib/integrations/integration-icons";
import { lowerFirst } from "~/lib/strings";
import { brandlessToolIcon } from "./animated-tool-icons";
import { presentTool, toolCategory, type ToolCallView } from "./tool-call-presentation";

/**
 * How a finished run of tool calls is summarized — the narrative headline and
 * the glyphs of the services it touched. Its own module because two surfaces
 * summarize a run the same way: the turn's top-level activity trail
 * (`ToolCallGroup`) and a spawned sub-agent's nested trail (`SubAgentCard`).
 * Keeping it here rather than in either one avoids a cycle between them.
 *
 * Derivation only — `RunGlyphCluster` renders the glyphs this picks.
 */

/** One coin in the run summary: an integration brand tile, or a system mark. */
export type RunGlyph =
  | { kind: "brand"; key: string; brand: IntegrationBrand }
  | { kind: "icon"; key: string; Icon: LucideIcon };

/**
 * The distinct glyphs a finished run touched, in first-seen order: an
 * integration's brand coin where the tool has one, otherwise the brandless
 * tool's own mark (web_search → globe, corpus_search → library, …). Deduped so
 * repeated calls collapse to a single coin and a Gmail-read-then-web-search run
 * reads as gmail + globe.
 */
export function runGlyphs(tools: ToolCallView[]): RunGlyph[] {
  const glyphs: RunGlyph[] = [];
  const seenBrands = new Set<IntegrationBrand>();
  // Deduped by the component itself, not by a name: several tools deliberately
  // share one mark (both `mcp.*` tools draw the plug, both workflow authoring
  // tools draw the flow), and two of them in one run must still collapse to a
  // single coin.
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
      // The first tool name that introduced this mark is unique across the
      // list — every later one is skipped above — so it is a stable React key.
      glyphs.push({ kind: "icon", key: tool.toolName, Icon });
    }
  }

  return glyphs;
}

/**
 * Narrative headline for a finished run — what Alfred *did*, as a sentence
 * rather than a tally. Reads vs. writes are split by `toolCategory`:
 *  - one kind of read → that read's done label   ("Checked your calendar")
 *  - several reads     → "Searched multiple sources"
 *  - one write          → that write's done label  ("Sent a Gmail draft")
 *  - several writes      → "Finished N actions"
 *  - both                → "<reads> and <writes, lowercased>"
 * The integration glyphs alongside the headline already say *which* services
 * were touched, so the text is free to describe the shape of the work. Plumbing
 * (connecting an integration, spawning a sub-agent) is excluded from the tally.
 *
 * Only steps that actually landed are counted: a failed calendar read must not
 * read as "Checked your calendar". The trail carries its own failure marker, so
 * the headline is free to be about the work that got done.
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

  // Nothing countable landed. If steps failed, say so rather than claiming
  // work; otherwise the run was pure plumbing and "worked on it" is accurate.
  return tools.some((t) => t.status === "failed") ? "Couldn't finish that" : "Worked on it";
}
