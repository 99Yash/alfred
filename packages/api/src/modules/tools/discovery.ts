import {
  integrationFromToolName,
  isToolName,
  type IntegrationSlug,
  type ToolName,
  type ToolRiskTier,
} from "@alfred/contracts";
import {
  availableToolNames,
  readIntegrationAvailability,
  type IntegrationAvailabilitySnapshot,
  type ToolAvailabilityContext,
} from "../integrations/availability";
import { getTool, listRegisteredTools, type RegisteredTool } from "./registry";

export interface ToolSearchCandidate {
  name: ToolName;
  title: string;
  summary: string;
  risk: ToolRiskTier;
  availability: "available";
  reason: string;
}

interface RankedCandidate extends ToolSearchCandidate {
  score: number;
  preloadEligible: boolean;
}

export interface ToolCatalogAccess {
  allowedIntegrations: readonly string[];
  availableTools: ReadonlySet<ToolName>;
}

export function searchToolCatalog(args: {
  query: string;
  limit?: number;
  tools?: readonly RegisteredTool[];
  access: ToolCatalogAccess;
}): ToolSearchCandidate[] {
  return rankToolCatalog(args)
    .slice(0, boundedLimit(args.limit, 5))
    .map(({ score: _score, preloadEligible: _preloadEligible, ...candidate }) => candidate);
}

export async function searchAvailableTools(args: {
  userId: string;
  query: string;
  limit?: number;
  allowedIntegrations: readonly string[];
  context: ToolAvailabilityContext;
  availability?: IntegrationAvailabilitySnapshot;
}): Promise<ToolSearchCandidate[]> {
  const tools = listRegisteredTools();
  const availability = args.availability ?? (await readIntegrationAvailability(args.userId));
  const availableTools = availableToolNames(
    availability,
    tools,
    args.allowedIntegrations,
    args.context,
  );
  return searchToolCatalog({
    query: args.query,
    limit: args.limit,
    tools,
    access: { allowedIntegrations: args.allowedIntegrations, availableTools },
  });
}

/** Deterministic first-turn selection. Full schemas are returned only by name. */
export async function preloadToolsForPrompt(args: {
  userId: string;
  prompt: string;
  allowedIntegrations: readonly string[];
  activeTools: readonly ToolName[];
  limit?: number;
  context: ToolAvailabilityContext;
  availability?: IntegrationAvailabilitySnapshot;
}): Promise<ToolName[]> {
  const tools = listRegisteredTools();
  const availability = args.availability ?? (await readIntegrationAvailability(args.userId));
  const availableTools = availableToolNames(
    availability,
    tools,
    args.allowedIntegrations,
    args.context,
  );
  return preloadToolCatalog({
    prompt: args.prompt,
    limit: args.limit,
    tools,
    activeTools: args.activeTools,
    access: { allowedIntegrations: args.allowedIntegrations, availableTools },
  });
}

export function preloadToolCatalog(args: {
  prompt: string;
  limit?: number;
  tools?: readonly RegisteredTool[];
  activeTools: readonly ToolName[];
  access: ToolCatalogAccess;
}): ToolName[] {
  const active = new Set(args.activeTools);
  return rankToolCatalog({
    query: args.prompt,
    limit: args.limit ?? 4,
    tools: args.tools,
    access: args.access,
  })
    .filter(
      (candidate) =>
        candidate.score >= 30 && candidate.preloadEligible && !active.has(candidate.name),
    )
    .slice(0, boundedLimit(args.limit, 4))
    .map((candidate) => candidate.name);
}

/** Extract bounded user-authored text without treating tool/assistant output as intent. */
export function latestUserPrompt(
  transcript: readonly { role: string; content: unknown }[],
): string {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index];
    if (message?.role !== "user") continue;
    return textFromContent(message.content).slice(0, 8_000);
  }
  return "";
}

export async function resolveExactToolLoad(args: {
  userId: string;
  name: string;
  allowedIntegrations: readonly string[];
  context: ToolAvailabilityContext;
  availability?: IntegrationAvailabilitySnapshot;
}): Promise<
  | { ok: true; name: ToolName }
  | { ok: false; status: "unknown_tool" | "not_allowed" | "unavailable"; reason: string }
> {
  if (!isToolName(args.name) || !getTool(args.name)) {
    return { ok: false, status: "unknown_tool", reason: `Tool '${args.name}' is not registered.` };
  }
  const integration = integrationFromToolName(args.name);
  if (
    integration !== "system" &&
    args.allowedIntegrations.length > 0 &&
    !args.allowedIntegrations.includes(integration)
  ) {
    return {
      ok: false,
      status: "not_allowed",
      reason: `Tool '${args.name}' is outside this workflow's integration allowlist.`,
    };
  }
  const tool = getTool(args.name);
  if (!tool) {
    return { ok: false, status: "unknown_tool", reason: `Tool '${args.name}' is not registered.` };
  }
  const availability = args.availability ?? (await readIntegrationAvailability(args.userId));
  const available = availableToolNames(
    availability,
    [tool],
    args.allowedIntegrations,
    args.context,
  );
  if (!available.has(args.name)) {
    return {
      ok: false,
      status: "unavailable",
      reason: `Tool '${args.name}' is not available in this run's current context.`,
    };
  }
  return { ok: true, name: args.name };
}

function rankToolCatalog(args: {
  query: string;
  limit?: number;
  tools?: readonly RegisteredTool[];
  access: ToolCatalogAccess;
}): RankedCandidate[] {
  const query = normalize(args.query);
  if (!query) return [];
  const queryTokens = meaningfulTokens(query);
  const allowed = new Set(args.access.allowedIntegrations);
  const ranked: RankedCandidate[] = [];

  for (const tool of args.tools ?? listRegisteredTools()) {
    if (!toolIsAvailable(tool.name, tool.integration, allowed, args.access.availableTools))
      continue;
    const match = scoreTool(tool, query, queryTokens);
    if (match.score <= 0) continue;
    ranked.push({
      name: tool.name,
      title: tool.discovery.title,
      summary: tool.discovery.summary,
      risk: tool.riskTier,
      availability: "available",
      reason: match.reason,
      score: match.score,
      preloadEligible: match.preloadEligible,
    });
  }

  return ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function toolIsAvailable(
  name: ToolName,
  integration: IntegrationSlug,
  allowed: ReadonlySet<string>,
  available: ReadonlySet<ToolName>,
): boolean {
  if (integration !== "system" && allowed.size > 0 && !allowed.has(integration)) return false;
  return available.has(name);
}

function boundedLimit(limit: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(limit ?? fallback, 10));
}

function scoreTool(
  tool: RegisteredTool,
  query: string,
  queryTokens: ReadonlySet<string>,
): { score: number; reason: string; preloadEligible: boolean } {
  const name = normalize(tool.name);
  if (query === name) return { score: 1_000, reason: "exact tool name", preloadEligible: true };

  const aliases = tool.discovery.aliases ?? [];
  for (const alias of aliases) {
    if (query === normalize(alias))
      return { score: 900, reason: `exact alias: ${alias}`, preloadEligible: true };
  }

  let score = 0;
  let reason = "catalog text match";
  let matchedAlias = false;
  let matchedEntity = false;
  let matchedVerb = false;
  for (const alias of aliases) {
    if (containsPhrase(query, alias)) {
      score += 120;
      reason = `alias match: ${alias}`;
      matchedAlias = true;
    }
  }
  score += scorePhrases(tool.discovery.tags, query, 35, "tag", (value) => (reason = value));
  score += scorePhrases(tool.discovery.entities, query, 35, "entity", (value) => {
    reason = value;
    matchedEntity = true;
  });
  score += scorePhrases(tool.discovery.verbs, query, 30, "verb", (value) => {
    reason = value;
    matchedVerb = true;
  });

  const nameTokens = meaningfulTokens(name);
  for (const token of nameTokens) if (queryTokens.has(token)) score += 20;
  for (const token of meaningfulTokens(normalize(tool.discovery.title))) {
    if (queryTokens.has(token)) score += 8;
  }
  for (const token of meaningfulTokens(normalize(tool.discovery.summary))) {
    if (queryTokens.has(token)) score += 2;
  }
  return {
    score,
    reason,
    // Search may rank broad noun/tag matches, but preloading a full schema
    // requires intent evidence: a known phrase, or an action applied to an
    // entity. This keeps sibling read/write tools out of ambiguous prompts.
    preloadEligible: matchedAlias || (matchedEntity && matchedVerb),
  };
}

function scorePhrases(
  values: readonly string[] | undefined,
  query: string,
  points: number,
  kind: string,
  setReason: (reason: string) => void,
): number {
  let score = 0;
  for (const value of values ?? []) {
    if (!containsPhrase(query, value)) continue;
    score += points;
    setReason(`${kind} match: ${value}`);
  }
  return score;
}

function containsPhrase(haystack: string, needle: string): boolean {
  const normalized = normalize(needle);
  return normalized.length > 0 && ` ${haystack} `.includes(` ${normalized} `);
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const STOP_WORDS = new Set(["a", "an", "and", "for", "in", "my", "of", "on", "the", "to", "with"]);

function meaningfulTokens(value: string): Set<string> {
  return new Set(value.split(" ").filter((token) => token.length > 1 && !STOP_WORDS.has(token)));
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (typeof part === "string") return [part];
      if (!part || typeof part !== "object") return [];
      const text = Reflect.get(part, "text");
      return typeof text === "string" ? [text] : [];
    })
    .join(" ");
}
