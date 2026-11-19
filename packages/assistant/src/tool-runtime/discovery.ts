import type { TranscriptMessage } from "@alfred/ai";
import {
  CODE_RUN_TOOL,
  type IntegrationSlug,
  isToolName,
  isWriteRiskTier,
  MCP_LIST_TOOLS_MAX_LIMIT,
  type IntegrationAvailabilitySnapshot,
  type ToolName,
  type ToolRunContext,
  type ToolRiskTier,
  type ToolAvailabilityResult,
  type ToolUnavailabilityCode,
  toMcpToolRef,
  type McpToolDiscoveryHit,
  type McpToolRef,
  type ToolRouteQuote,
} from "@alfred/contracts";
import { readIntegrationAvailability } from "@alfred/assistant/connections";
import { singularizePhrase } from "@alfred/assistant/search-words";
import {
  catalogWords,
  connectionNameWords,
  mcpServerIdsAdmittedBy,
  searchMcpToolsLocal,
} from "@alfred/assistant/connections/mcp";
import { MCP_READ_PATH } from "./code-mode/host-bindings";
import {
  quoteCuratedToolRoute,
  quoteMcpToolRoute,
  routeQuoteRun,
  type RouteQuoteRun,
} from "./route-quote";
import {
  evaluateToolAvailability,
  evaluateToolCatalog,
  getTool,
  listRegisteredTools,
  type RegisteredTool,
} from "./internal/registry";

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

/** What ranking builds: a curated hit, or a connected catalog hit for `mcp.call`. */
type RankedHit =
  /** A curated catalog hit, including `mcp.call` itself. No ref: only a connected hit carries one. */
  | (ToolCandidateBase & { ref?: never; hostFunction?: never } & AvailabilityTag)
  | (ToolCandidateBase & {
      name: "mcp.call";
      /**
       * A connected catalog hit; pass this ref's fields to mcp.call. It has no catalog revision:
       * the server binds one when the call is proposed (ADR-0088 amendment 2026-11-18).
       */
      ref: McpToolRef;
      hostFunction?: never;
    } & AvailabilityTag);

/**
 * A read hit in a `code_run` run that runs with no card (ADR-0124): call `hostFunction` inside
 * `system.code_run`. A connected read is `mcp.read(ref, args)`; a curated read has no ref.
 * Search builds it after ranking, only from an available hit.
 */
type ScriptReadHit = ToolCandidateBase & {
  name: typeof CODE_RUN_TOOL;
  availability: "available";
} & ToolRouteQuote &
  (
    | { hostFunction: typeof MCP_READ_PATH; ref: McpToolRef }
    | { hostFunction: ToolName; ref?: never }
  );

/**
 * A direct hit carries its route quote (ADR-0130 C1). Three hits carry none: an unavailable hit, a
 * curated tool whose tier comes from its input (`mcp.call` with no ref), and a connected hit whose
 * revision search did not record (a bug path).
 */
export type ToolSearchCandidate = RankedHit | (RankedHit & ToolRouteQuote) | ScriptReadHit;

type RankedCandidate = RankedHit & {
  score: number;
  preloadEligible: boolean;
};

export interface ToolCatalogAccess {
  allowedIntegrations: readonly IntegrationSlug[];
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
  allowedIntegrations: readonly IntegrationSlug[];
  context: ToolRunContext;
  /** The thread of the run's Full Autonomy flag, as dispatch reads it (`approvalThreadId`). */
  approvalThreadId?: string | undefined;
  availability?: IntegrationAvailabilitySnapshot | undefined;
}): Promise<ToolSearchCandidate[]> {
  const tools = listRegisteredTools();
  const snapshot = args.availability ?? (await readIntegrationAvailability(args.userId));
  const scriptReads = args.context.readPath === "code_run";
  // A `code_run` run hides some reads, but a script still calls them. So rank with the direct
  // view of the run, and route each read hit after ranking (the connected summary does the same).
  const { readPath: _readPath, ...directView } = args.context;

  const availability = evaluateToolCatalog(
    snapshot,
    tools,
    args.allowedIntegrations,
    scriptReads ? directView : args.context,
  );

  const curated = rankToolCatalog({
    query: args.query,
    tools,
    includeUnavailable: true,
    access: { allowedIntegrations: args.allowedIntegrations, availability },
  });

  const mcpAvailable = availability.get("mcp.call")?.available === true;
  const remote: RankedCandidate[] = [];
  // The revision each hit's route is quoted at. Search reads the current catalog of each
  // connection, so one connection has one revision. The model never sees it.
  const revisions = new Map<string, string>();

  if (mcpAvailable) {
    const queryWords = catalogWords(args.query);
    // A full query rarely occurs verbatim in a descriptor, so scan pages and rank by token.
    let cursor: string | null = null;
    const serverIds = await mcpServerIdsAdmittedBy(args.userId, args.allowedIntegrations);

    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await searchMcpToolsLocal({
        userId: args.userId,
        serverIds,
        detail: "summary",
        // `limit` counts hits, so with the 10-page bound it caps the reachable set.
        limit: MCP_LIST_TOOLS_MAX_LIMIT,
        ...(cursor ? { cursor } : {}),
      });

      for (const hit of page.tools) {
        const score = scoreMcpHit(hit, queryWords);

        if (score <= 0) continue;

        revisions.set(hit.ref.connectionId, hit.ref.catalogRevision);

        remote.push({
          name: "mcp.call",
          title: hit.title ?? hit.ref.remoteName,
          summary: hit.description ?? "Connected MCP tool",
          risk: "high",
          reason: `connected MCP catalog: ${hit.namespace}`,
          ref: toMcpToolRef(hit.ref),
          availability: "available",
          score,
          preloadEligible: false,
        });
      }

      cursor = page.nextCursor;

      if (!cursor) break;
    }
  }

  const ranked = [...curated, ...remote].toSorted(
    (a, b) =>
      rankAvailability(b) - rankAvailability(a) ||
      b.score - a.score ||
      (a.ref ? 1 : 0) - (b.ref ? 1 : 0) ||
      a.title.localeCompare(b.title),
  );

  const selected = ranked.slice(0, boundedLimit(args.limit, 5));

  // One read of the run facts for all hits. Full Autonomy waives a card, so it can send a gated
  // read to the script.
  const run = routeQuoteRun({
    userId: args.userId,
    readPath: args.context.readPath,
    approvalThreadId: args.approvalThreadId,
  });

  return Promise.all(
    selected.map(({ score: _score, preloadEligible: _preloadEligible, ...candidate }) =>
      candidate.ref
        ? routeConnectedHit(candidate, run, revisions)
        : routeCuratedHit(candidate, run),
    ),
  );
}

/**
 * Search quotes the current route and approval of a connected hit (ADR-0130 C1). A script hit
 * names `system.code_run` with `mcp.read`. Dispatch decides again for the call, so a policy
 * change between the two cannot run a call on a stale route.
 */
async function routeConnectedHit(
  candidate: Extract<RankedHit, { name: "mcp.call" }>,
  run: RouteQuoteRun,
  revisions: ReadonlyMap<string, string>,
): Promise<ToolSearchCandidate> {
  const catalogRevision = revisions.get(candidate.ref.connectionId);

  // Every connected hit came from a page that named its revision, so a miss is a bug. Quote
  // nothing: dispatch decides the call anyway.
  if (catalogRevision === undefined) return candidate;

  const { quote, riskTier } = await quoteMcpToolRoute(run, {
    connectionId: candidate.ref.connectionId,
    remoteName: candidate.ref.remoteName,
    catalogRevision,
  });

  if (quote.route === "direct") return { ...candidate, risk: riskTier, ...quote };

  return {
    name: CODE_RUN_TOOL,
    hostFunction: MCP_READ_PATH,
    ref: candidate.ref,
    title: candidate.title,
    summary: candidate.summary,
    reason: candidate.reason,
    risk: riskTier,
    availability: "available",
    ...quote,
  };
}

/**
 * A curated hit takes the same quote. The staging arm is an input, so a `fast_path` catalog read
 * (`mcp.list_tools`) quotes the script, as dispatch runs it. An unavailable hit keeps its reason
 * and quotes nothing.
 */
async function routeCuratedHit(
  candidate: Extract<RankedHit, { ref?: never }>,
  run: RouteQuoteRun,
): Promise<ToolSearchCandidate> {
  const tool = getTool(candidate.name);

  if (!tool || candidate.availability !== "available") return candidate;

  const quote = await quoteCuratedToolRoute(run, tool);

  if (quote === null) return candidate;

  if (quote.route === "direct") return { ...candidate, ...quote };

  return {
    name: CODE_RUN_TOOL,
    hostFunction: candidate.name,
    title: candidate.title,
    summary: candidate.summary,
    reason: candidate.reason,
    risk: candidate.risk,
    availability: "available",
    ...quote,
  };
}

/** Above one name-word hit (55), so naming the connection ranks its tools over another server's. */
const MCP_CONNECTION_NAME_BONUS = 60;

function scoreMcpHit(hit: McpToolDiscoveryHit, queryWords: ReadonlySet<string>): number {
  const name = catalogWords(hit.ref.remoteName);
  const title = catalogWords(hit.title ?? "");
  const description = catalogWords(hit.description ?? "");
  let score = 0;

  for (const word of queryWords) {
    if (name.has(word)) score += 55;
    else if (title.has(word)) score += 30;
    else if (description.has(word)) score += 4;
  }

  // The namespace is an opaque id, so only the label can name the connection.
  const labelWords = connectionNameWords(hit.connection.label);

  if ([...queryWords].some((word) => labelWords.has(word))) score += MCP_CONNECTION_NAME_BONUS;

  return score;
}

/** Deterministic first-turn selection. Full schemas are returned only by name. */
export async function preloadToolsForPrompt(args: {
  userId: string;
  prompt: string;
  allowedIntegrations: readonly IntegrationSlug[];
  activeTools: readonly ToolName[];
  limit?: number | undefined;
  context: ToolRunContext;
  availability?: IntegrationAvailabilitySnapshot | undefined;
}): Promise<ToolName[]> {
  // In a `code_run` run, a read is in the `system.code_run` index. Preload one only to have the
  // model call it directly, which dispatch refuses unless the read waits for a card (ADR-0124).
  const tools = listRegisteredTools().filter(
    (tool) => args.context.readPath !== "code_run" || !tool.codeModeRead,
  );

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
export function latestUserPrompt(transcript: readonly TranscriptMessage[]): string {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index];

    if (message?.role !== "user") continue;

    // An image or a file part has no text, so it drops out of the prompt.
    const text = Array.isArray(message.content)
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ")
      : message.content;

    return text.slice(0, 8_000);
  }

  return "";
}

export async function resolveExactToolLoad(args: {
  userId: string;
  name: string;
  allowedIntegrations: readonly IntegrationSlug[];
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
  // Singularize once: "my pull requests" must match the entity "pull request".
  const matchText = singularizePhrase(query);
  const queryTokens = meaningfulTokens(matchText);
  const queryHasReadIntent = hasReadIntent(meaningfulTokens(query));
  const ranked: RankedCandidate[] = [];

  for (const tool of args.tools ?? listRegisteredTools()) {
    const result = args.access.availability.get(tool.name);

    // A kernel tool is always on the surface, so a hit for it only crowds out a real one.
    if (tool.availability?.surface === "kernel") continue;

    // The workflow allowlist is a hard scope, not a fixable gap: never surface these.
    if (result && !result.available && result.code === "not_allowed") continue;

    const available = result?.available === true;
    const unavailableReason = !available && result ? result.reason : undefined;

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

    ranked.push(
      unavailableReason
        ? { ...scored, availability: "unavailable", unavailableReason }
        : { ...scored, availability: "available" },
    );
  }

  // Runnable first, so an unavailable match never crowds out a runnable tool.
  return ranked.toSorted(
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
  // The scorePhrases callbacks set these. A plain `let` reads as `false` afterwards, because
  // flow analysis does not see an assignment inside a callback.
  const matched = { entity: false, verb: false };

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
    matched.entity = true;
  });
  // A verb names the action, not the object, and most tools list several. "read or list"
  // is one intent, so the verb field scores once and cannot outrank an entity match.
  score += Math.min(
    VERB_POINTS,
    scorePhrases(tool.discovery.verbs, matchText, VERB_POINTS, "verb", (value) => {
      reason = value;
      matched.verb = true;
    }),
  );

  // Fold number on this side too: the query tokens are singular.
  for (const token of catalogTokens(name)) if (queryTokens.has(token)) score += 20;

  for (const token of catalogTokens(normalize(tool.discovery.title))) {
    if (queryTokens.has(token)) score += 8;
  }

  for (const token of catalogTokens(normalize(tool.discovery.summary))) {
    if (queryTokens.has(token)) score += 2;
  }

  // Preload needs intent: an alias, or an entity plus a verb. A generic read word
  // counts only for read-only tools, so a read request never preloads a write tool.
  const readOnly = !isWriteRiskTier(tool.riskTier);

  const preloadEligible =
    matchedAlias ||
    (matched.entity && matched.verb) ||
    (matched.entity && readOnly && queryHasReadIntent);

  return { score, reason, preloadEligible };
}

const VERB_POINTS = 30;

function catalogTokens(value: string): Set<string> {
  return meaningfulTokens(singularizePhrase(value));
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

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function meaningfulTokens(value: string): Set<string> {
  return new Set(value.split(" ").filter((token) => token.length > 1 && !STOP_WORDS.has(token)));
}
