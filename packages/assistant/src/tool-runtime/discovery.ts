import {
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
 * A tool surfaced by search. Availability is a discriminated union so a reason
 * exists exactly when — and only when — the tool can't run: an "available"
 * candidate can't carry a stray `unavailableReason`, and an "unavailable" one
 * can't omit it. Whether the tool can run is read off the `availability` tag,
 * not a separate boolean.
 *
 * The `ref` is a second discriminant: only `mcp.call` — the one tool whose
 * args carry a connected-catalog reference — may carry it. A curated hit for
 * any other name with a `ref` (e.g. `{ name: "gmail.search", ref: {...} }`)
 * is unrepresentable, so a stray ref can't route a registered tool at a
 * remote descriptor. `mcp.call` itself leaves `ref` optional: the curated
 * `mcp.call` entry has none, while a connected-catalog hit carries the exact
 * ref whose fields (`connectionId`, `remoteName`, `catalogRevision`) flatten
 * into the `mcp.call` args.
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
  /**
   * Availability of every candidate tool, evaluated once by the caller (see
   * {@link evaluateToolCatalog}). Both "can it run" and "why not" read from the
   * same {@link ToolAvailabilityResult}, so a surfaced tool can't disagree with
   * its own reason. A tool absent from the map is treated as unavailable with no
   * explanation — hidden even when {@link ToolSearchArgs.includeUnavailable} is set.
   */
  availability: ReadonlyMap<ToolName, ToolAvailabilityResult>;
}

interface ToolSearchArgs {
  query: string;
  limit?: number | undefined;
  tools?: readonly RegisteredTool[] | undefined;
  access: ToolCatalogAccess;
  /**
   * Include strong matches the run can't execute yet, flagged with a reason, so
   * the model can explain the gap ("Gmail isn't connected") instead of getting
   * an empty result and guessing. Off by default — internal ranking (preload)
   * only ever wants runnable tools.
   */
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
    // The local catalog read is bounded and only returns current owned revisions.
    // A full query string rarely occurs verbatim in a descriptor, so scan compact
    // pages and rank individual fields against the same query tokens as curated tools.
    let cursor: string | null = null;

    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await searchMcpToolsLocal({
        userId: args.userId,
        detail: "summary",
        // `limit` counts matching hits, not descriptors scanned, so together with the
        // 10-page loop bound it sets the reachable set, and the page size sets the
        // round-trip count. At 10 that set was 100 — half the callee's own
        // 200-descriptor budget, with matches discarded and a live cursor thrown away.
        // Widening it only grows recall, but the sort below is over a larger set, so
        // which candidates make the cut can change.
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

  // Route the load decision through the same evaluator that ranks the catalog,
  // so the specific reason `system.search_tools` surfaced ("Notion is not
  // connected.") is exactly what the model receives when it acts on that name —
  // never a generic "not available in this context" that drops the code and the
  // fix. The allowlist is one of those reasons (`not_allowed`), so the inline
  // scope check disappears with it.
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

/**
 * Minimum score for an *unavailable* tool to be surfaced. A tool the run can't
 * execute is only worth mentioning when the query clearly intends it (a known
 * phrase or an action on an entity — the same evidence bar as preload); a weak
 * incidental token match stays hidden so the catalog isn't polluted with tools
 * the user would have to go connect.
 */
const UNAVAILABLE_MIN_SCORE = 30;

function rankToolCatalog(args: ToolSearchArgs): RankedCandidate[] {
  const query = normalize(args.query);

  if (!query) return [];
  const queryTokens = meaningfulTokens(query);
  // Singularize once so phrase matching is number-insensitive: a plural prompt
  // ("my pull requests") matches a singular authored entity ("pull request").
  // The read-intent flag is a query-level property, so it is computed here rather
  // than re-derived per tool.
  const matchText = singularizePhrase(query);
  const queryHasReadIntent = hasReadIntent(queryTokens);
  const ranked: RankedCandidate[] = [];

  for (const tool of args.tools ?? listRegisteredTools()) {
    const result = args.access.availability.get(tool.name);

    // The workflow integration allowlist is a hard scope, not a fixable gap:
    // tools outside it are never surfaced, available or not. It reads from the
    // same evaluated result as every other reason (`not_allowed`) rather than a
    // parallel predicate, so "what may this run touch" has one owner.
    if (result && !result.available && result.code === "not_allowed") continue;

    const available = result?.available === true;
    // Availability and reason come from the one result object, so they can't
    // diverge. Only a genuine unavailable result carries a reason; a tool absent
    // from the map has none and stays hidden.
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

    // The `ref` discriminant flows from the tool name: only `mcp.call` may
    // carry one, and the curated catalog entry never does. Branch here so a
    // curated hit for any other name can't acquire a stray `ref`, and the
    // `ref?: never` arm stays unrepresentable rather than merely unset.
    // The availability discriminant flows from `unavailableReason`: it is set
    // iff the tool is unavailable (guarded above), so "available" candidates
    // never carry it.
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

  // Runnable tools first, then by match strength — an unavailable exact match
  // never crowds a runnable tool out of the limited result window.
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

/** Sort key: runnable tools ahead of surfaced-but-unavailable ones. */
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

  // Search may rank broad noun/tag matches, but preloading a full schema requires
  // intent evidence, not just a noun in the prompt. A known phrase (alias) is
  // intent on its own. Otherwise a matched entity must be paired with a verb: a
  // catalog verb names the exact action for any tool, and — only for a read-only
  // tool — a generic information-seeking word ("summary", "show", "what") counts
  // too, since natural phrasing routinely skips the narrow catalog verbs. A
  // state-changing tool (`medium`/`high`) still requires a catalog verb, so a
  // bare read-flavored request can never force-load a write sibling.
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

/**
 * Word-boundary phrase containment, number-insensitive. `haystack` is the
 * singularized query (see {@link rankToolCatalog}); the needle is singularized
 * here to the same form, so a plural prompt matches a singular authored phrase
 * and vice versa. Derived entities already carry both number forms — this closes
 * the same gap for hand-authored phrases without re-listing plurals per tool.
 */
function containsPhrase(haystack: string, needle: string): boolean {
  const normalized = singularizePhrase(normalize(needle));

  return normalized.length > 0 && ` ${haystack} `.includes(` ${normalized} `);
}

/**
 * Generic information-seeking words that signal a read intent even when the
 * user's phrasing skips a tool's own catalog verbs — "give me a summary of…",
 * "show my…", "what are my…". Used only to gate preload of *read-only* tools
 * (see {@link scoreTool}); they never elevate a state-changing tool. This is
 * English request vocabulary, kept as a flat token set rather than per-tool
 * catalog copy, and complements the derivation's verb synonyms (which map onto a
 * specific action; these are action-agnostic).
 */
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

      if (!part || typeof part !== "object") return [];
      const text = Reflect.get(part, "text");

      return typeof text === "string" ? [text] : [];
    })
    .join(" ");
}
