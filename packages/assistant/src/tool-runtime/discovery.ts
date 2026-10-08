import {
  getStringPath,
  isToolName,
  isWriteRiskTier,
  MCP_LIST_TOOLS_MAX_LIMIT,
  type IntegrationAvailabilitySnapshot,
  type ToolName,
  type ToolRunContext,
  type ToolRiskTier,
  type ToolAvailabilityResult,
  type ToolUnavailabilityCode,
  type ExternalToolRef,
  type McpToolDiscoveryHit,
} from "@alfred/contracts";
import { readIntegrationAvailability } from "@alfred/assistant/connections";
import { searchMcpToolsLocal } from "@alfred/assistant/connections/mcp";
import { resolveMcpCallRiskTier } from "@alfred/assistant/tool-runtime/mcp";
import {
  evaluateToolAvailability,
  evaluateToolCatalog,
  getTool,
  listRegisteredTools,
  type RegisteredTool,
} from "./internal/registry";
import { singularizePhrase } from "./internal/metadata-defaults";

interface ToolCandidateBase {
  name: ToolName;
  title: string;
  summary: string;
  risk: ToolRiskTier;
  reason: string;
}

/**
 * A tool surfaced by search. A reason exists only when the tool cannot run.
 * Only `mcp.call` may carry a `ref`, so a stray ref cannot route another tool at a remote descriptor.
 */
type AvailabilityTag =
  | { availability: "available" }
  | { availability: "unavailable"; unavailableReason: string };

export type ToolSearchCandidate =
  | (ToolCandidateBase & {
      name: Exclude<ToolName, "mcp.call">;
      ref?: never;
    } & AvailabilityTag)
  | (ToolCandidateBase & {
      name: "mcp.call";
      /** Present only for a connected catalog hit; pass this ref's fields to mcp.call. */
      ref?: ExternalToolRef;
    } & AvailabilityTag);

type RankedCandidate = ToolSearchCandidate & {
  score: number;
  preloadEligible: boolean;
};

export interface ToolCatalogAccess {
  allowedIntegrations: readonly string[];
  /** From {@link evaluateToolCatalog}. A tool absent from the map is always hidden. */
  availability: ReadonlyMap<ToolName, ToolAvailabilityResult>;
}

interface ToolSearchArgs {
  query: string;
  limit?: number | undefined;
  tools?: readonly RegisteredTool[] | undefined;
  access: ToolCatalogAccess;
  /** Include strong matches the run cannot execute yet, with a reason the model can relay. */
  includeUnavailable?: boolean;
}

export function searchToolCatalog(args: ToolSearchArgs): ToolSearchCandidate[] {
  return rankToolCatalog(args)
    .slice(0, boundedLimit(args.limit, 5))
    .map(({ score: _score, preloadEligible: _preloadEligible, ...candidate }) => candidate);
}

export async function searchAvailableTools(args: {
  userId: string;
  query: string;
  limit?: number | undefined;
  allowedIntegrations: readonly string[];
  context: ToolRunContext;
  availability?: IntegrationAvailabilitySnapshot | undefined;
}): Promise<ToolSearchCandidate[]> {
  const tools = listRegisteredTools();
  const snapshot = args.availability ?? (await readIntegrationAvailability(args.userId));
  const availability = evaluateToolCatalog(snapshot, tools, args.allowedIntegrations, args.context);

  const curated = rankToolCatalog({
    query: args.query,
    tools,
    includeUnavailable: true,
    access: { allowedIntegrations: args.allowedIntegrations, availability },
  });

  const mcpAvailable = availability.get("mcp.call")?.available === true;
  const remote: RankedCandidate[] = [];

  if (mcpAvailable) {
    // A full query rarely occurs verbatim in a descriptor, so scan pages and rank by token.
    let cursor: string | null = null;

    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await searchMcpToolsLocal({
        userId: args.userId,
        detail: "summary",
        // `limit` counts hits, so with the 10-page bound it caps the reachable set.
        limit: MCP_LIST_TOOLS_MAX_LIMIT,
        ...(cursor ? { cursor } : {}),
      });

      for (const hit of page.tools) {
        const score = scoreMcpHit(hit, args.query);

        if (score <= 0) continue;

        remote.push({
          name: "mcp.call",
          title: hit.title ?? hit.ref.remoteName,
          summary: hit.description ?? "Connected MCP tool",
          risk: "high",
          reason: `connected MCP catalog: ${hit.namespace}`,
          ref: hit.ref,
          availability: "available",
          score,
          preloadEligible: false,
        });
      }

      cursor = page.nextCursor;

      if (!cursor) break;
    }
  }

  const ranked = [...curated, ...remote].sort(
    (a, b) =>
      rankAvailability(b) - rankAvailability(a) ||
      b.score - a.score ||
      (a.ref ? 1 : 0) - (b.ref ? 1 : 0) ||
      a.title.localeCompare(b.title),
  );

  const selected = ranked.slice(0, boundedLimit(args.limit, 5));

  return Promise.all(
    selected.map(async ({ score: _score, preloadEligible: _preloadEligible, ...candidate }) => {
      if (!candidate.ref) return candidate;

      const risk = await resolveMcpCallRiskTier({
        userId: args.userId,
        connectionId: candidate.ref.connectionId,
        remoteName: candidate.ref.remoteName,
        catalogRevision: candidate.ref.catalogRevision,
      });

      return { ...candidate, risk };
    }),
  );
}

function scoreMcpHit(hit: McpToolDiscoveryHit, query: string): number {
  const tokens = meaningfulTokens(normalize(query));

  const name = meaningfulTokens(
    normalize(hit.ref.remoteName.replaceAll("-", " ").replaceAll("_", " ")),
  );

  const title = meaningfulTokens(normalize(hit.title ?? ""));
  const description = meaningfulTokens(normalize(hit.description ?? ""));
  let score = 0;

  for (const token of tokens) {
    if (name.has(token)) score += 55;
    else if (title.has(token)) score += 30;
    else if (description.has(token)) score += 4;
  }

  if (tokens.has(normalize(hit.namespace)) || tokens.has(normalize(hit.connection.label))) {
    score += 10;
  }

  return score;
}

/** Deterministic first-turn selection. Full schemas are returned only by name. */
export async function preloadToolsForPrompt(args: {
  userId: string;
  prompt: string;
  allowedIntegrations: readonly string[];
  activeTools: readonly ToolName[];
  limit?: number | undefined;
  context: ToolRunContext;
  availability?: IntegrationAvailabilitySnapshot | undefined;
}): Promise<ToolName[]> {
  const tools = listRegisteredTools();
  const snapshot = args.availability ?? (await readIntegrationAvailability(args.userId));
  const availability = evaluateToolCatalog(snapshot, tools, args.allowedIntegrations, args.context);

  return preloadToolCatalog({
    prompt: args.prompt,
    limit: args.limit,
    tools,
    activeTools: args.activeTools,
    access: { allowedIntegrations: args.allowedIntegrations, availability },
  });
}

export function preloadToolCatalog(args: {
  prompt: string;
  limit?: number | undefined;
  tools?: readonly RegisteredTool[] | undefined;
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

/** Bounded user text only. Tool and assistant output is not intent. */
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
  context: ToolRunContext;
  availability?: IntegrationAvailabilitySnapshot | undefined;
}): Promise<
  | { ok: true; name: ToolName }
  | { ok: false; status: "unknown_tool" | ToolUnavailabilityCode; reason: string }
> {
  if (!isToolName(args.name)) {
    return { ok: false, status: "unknown_tool", reason: `Tool '${args.name}' is not registered.` };
  }

  const tool = getTool(args.name);

  if (!tool) {
    return { ok: false, status: "unknown_tool", reason: `Tool '${args.name}' is not registered.` };
  }

  // Same evaluator as search, so load returns the same specific reason.
  const snapshot = args.availability ?? (await readIntegrationAvailability(args.userId));

  const result = evaluateToolAvailability(
    snapshot,
    tool,
    new Set(args.allowedIntegrations),
    args.context,
  );

  if (!result.available) {
    return { ok: false, status: result.code, reason: result.reason };
  }

  return { ok: true, name: args.name };
}

/** An unavailable tool surfaces only on clear intent, the same bar as preload. */
const UNAVAILABLE_MIN_SCORE = 30;

function rankToolCatalog(args: ToolSearchArgs): RankedCandidate[] {
  const query = normalize(args.query);

  if (!query) return [];
  const queryTokens = meaningfulTokens(query);
  // Singularize once: "my pull requests" must match the entity "pull request".
  const matchText = singularizePhrase(query);
  const queryHasReadIntent = hasReadIntent(queryTokens);
  const ranked: RankedCandidate[] = [];

  for (const tool of args.tools ?? listRegisteredTools()) {
    const result = args.access.availability.get(tool.name);

    // The workflow allowlist is a hard scope, not a fixable gap: never surface these.
    if (result && !result.available && result.code === "not_allowed") continue;

    const available = result?.available === true;
    const unavailableReason = !available && result && !result.available ? result.reason : undefined;

    if (!available && (!args.includeUnavailable || !unavailableReason)) continue;

    const match = scoreTool(tool, query, matchText, queryTokens, queryHasReadIntent);

    if (match.score <= 0) continue;

    if (!available && match.score < UNAVAILABLE_MIN_SCORE) continue;

    const scored = {
      name: tool.name,
      title: tool.discovery.title,
      summary: tool.discovery.summary,
      risk: tool.riskTier,
      reason: match.reason,
      score: match.score,
      preloadEligible: match.preloadEligible,
    };

    // Branch on the name so only `mcp.call` can carry a `ref`.
    if (tool.name === "mcp.call") {
      ranked.push(
        unavailableReason
          ? { ...scored, name: tool.name, availability: "unavailable", unavailableReason }
          : { ...scored, name: tool.name, availability: "available" },
      );
    } else {
      ranked.push(
        unavailableReason
          ? { ...scored, name: tool.name, availability: "unavailable", unavailableReason }
          : { ...scored, name: tool.name, availability: "available" },
      );
    }
  }

  // Runnable first, so an unavailable match never crowds out a runnable tool.
  return ranked.sort(
    (a, b) =>
      rankAvailability(b) - rankAvailability(a) ||
      b.score - a.score ||
      a.name.localeCompare(b.name),
  );
}

function boundedLimit(limit: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(limit ?? fallback, 10));
}

function rankAvailability(candidate: RankedCandidate): number {
  return candidate.availability === "available" ? 1 : 0;
}

interface ToolScore {
  score: number;
  reason: string;
  preloadEligible: boolean;
}

function scoreTool(
  tool: RegisteredTool,
  query: string,
  matchText: string,
  queryTokens: ReadonlySet<string>,
  queryHasReadIntent: boolean,
): ToolScore {
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
    if (containsPhrase(matchText, alias)) {
      score += 120;
      reason = `alias match: ${alias}`;
      matchedAlias = true;
    }
  }

  score += scorePhrases(tool.discovery.tags, matchText, 35, "tag", (value) => (reason = value));
  score += scorePhrases(tool.discovery.entities, matchText, 35, "entity", (value) => {
    reason = value;
    matchedEntity = true;
  });
  score += scorePhrases(tool.discovery.verbs, matchText, 30, "verb", (value) => {
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

  // Preload needs intent: an alias, or an entity plus a verb. A generic read word
  // counts only for read-only tools, so a read request never preloads a write tool.
  const readOnly = !isWriteRiskTier(tool.riskTier);

  const preloadEligible =
    matchedAlias ||
    (matchedEntity && matchedVerb) ||
    (matchedEntity && readOnly && queryHasReadIntent);

  return { score, reason, preloadEligible };
}

function scorePhrases(
  values: readonly string[] | undefined,
  matchText: string,
  points: number,
  kind: string,
  setReason: (reason: string) => void,
): number {
  let score = 0;

  for (const value of values ?? []) {
    if (!containsPhrase(matchText, value)) continue;
    score += points;
    setReason(`${kind} match: ${value}`);
  }

  return score;
}

/** Word-boundary match. `haystack` is already singularized; the needle is singularized here. */
function containsPhrase(haystack: string, needle: string): boolean {
  const normalized = singularizePhrase(normalize(needle));

  return normalized.length > 0 && ` ${haystack} `.includes(` ${normalized} `);
}

/** Generic read words ("show", "what"). They gate preload of read-only tools only. */
const READ_INTENT_VERBS = new Set([
  "summary",
  "summarize",
  "summarise",
  "overview",
  "recap",
  "digest",
  "brief",
  "show",
  "tell",
  "give",
  "list",
  "view",
  "see",
  "read",
  "check",
  "find",
  "get",
  "review",
  "status",
  "what",
  "which",
  "who",
  "when",
  "where",
  "how",
  "any",
  "count",
]);

function hasReadIntent(queryTokens: ReadonlySet<string>): boolean {
  for (const token of queryTokens) if (READ_INTENT_VERBS.has(token)) return true;

  return false;
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

      const text = getStringPath(part, "text");

      return text === undefined ? [] : [text];
    })
    .join(" ");
}
