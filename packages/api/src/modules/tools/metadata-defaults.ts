/**
 * Baseline discovery metadata derivation (#413).
 *
 * Hand-authored `discovery` copy on `liveTool` calls is the curated ideal, but
 * it does not scale: every new integration tool — and, once they exist,
 * MCP/imported tools with only a server identity, a name, a description, and an
 * input schema — would otherwise be invisible to {@link searchToolCatalog}
 * except by its exact canonical name. This module derives a useful search
 * baseline from that identity so any registered tool participates in lazy
 * discovery, and merges local overrides on top so high-value tools can still be
 * tuned without re-listing everything the baseline already covers.
 *
 * The single derivation path is {@link deriveToolDiscovery}; `liveTool` calls it
 * for every builtin, and a future MCP importer should call it with the imported
 * server slug, tool name, description, and translated zod schema to get the same
 * search baseline.
 *
 * This module is only the *discovery* seam. Discovery metadata alone does not
 * make an imported tool loadable: two closed-world layers must open first — the
 * registry (`RegisteredTool.integration` / `liveTool` are keyed on the builtin
 * `IntegrationSlug`) and availability (`evaluateToolAvailability` keys on the
 * closed `ACCESS_SPECS`, so an unknown slug reads as permanently not-connected).
 * Until both open, a derived-metadata imported tool can be ranked in text but
 * never surfaced as runnable — this is a foundation, not a finished MCP path.
 */

import { humanizeSlug } from "@alfred/contracts";
import { z } from "zod";
import type { ToolDiscoveryMetadata } from "./registry";

/**
 * A provider identity used only as free search text — never validated or used
 * for a closed-world operation here. It is a builtin {@link IntegrationSlug}
 * today, but the derivation deliberately accepts any string so a future MCP
 * importer can pass an imported server slug (`linear`, `stripe`, …) without
 * widening the closed registry enums the builtin name/action checks depend on.
 */
export type ProviderLabel = string;

/**
 * Generic verb synonyms, keyed by the action's leading token. This is English
 * vocabulary, not a per-tool catalog: the baseline maps a user's likely phrasing
 * ("show my events", "open the page") onto the action's own verb so recall does
 * not depend on the author guessing every phrasing. Only the leading token is
 * expanded — unknown leads (`recent`, `batch`) simply contribute no synonyms.
 */
const VERB_SYNONYMS: Record<string, readonly string[]> = {
  search: ["find", "look up", "query"],
  list: ["show", "view", "browse"],
  get: ["read", "fetch", "open", "view"],
  read: ["view", "open", "fetch"],
  create: ["add", "new", "make", "start"],
  send: ["deliver", "share"],
  update: ["edit", "change", "modify", "set"],
  edit: ["update", "change", "modify"],
  append: ["add", "insert"],
  add: ["create", "insert"],
  delete: ["remove", "drop"],
  forget: ["remove", "delete"],
  export: ["download", "save"],
  download: ["export", "save"],
  fetch: ["get", "read", "load"],
  load: ["fetch", "open", "activate"],
  resolve: ["complete", "close", "finish"],
  redeploy: ["deploy", "restart", "rerun"],
  remember: ["save", "store", "note"],
  suggest: ["propose", "recommend"],
  promote: ["publish", "apply"],
  spawn: ["start", "launch", "delegate"],
};

/**
 * Input-schema property names that carry no capability signal — pagination,
 * opaque ids, and generic request plumbing. Excluded from derived entities so a
 * query like "page" or "limit" never surfaces an unrelated tool.
 */
const PLUMBING_FIELD_TOKENS = new Set([
  "id",
  "ids",
  "token",
  "cursor",
  "offset",
  "limit",
  "page",
  "pagetoken",
  "pagesize",
  "maxresults",
  "perpage",
  "q",
  "query",
  "format",
  "type",
  "mimetype",
  "order",
  "orderby",
  "input",
  "options",
  "option",
]);

export interface DeriveToolDiscoveryInput {
  /** Server/provider identity — a builtin integration slug or an imported MCP server slug. */
  integration: ProviderLabel;
  /** The tool's action slug, e.g. `create_event`. */
  action: string;
  /** The executable description; the derived `summary` default. */
  description: string;
  /** Input schema, read for its top-level field names. */
  inputSchema: z.ZodTypeAny;
  /** Hand-authored copy; each field takes precedence over the derived baseline. */
  overrides?: ToolDiscoveryMetadata;
}

/**
 * The discovery shape after derivation + override merge: `title` and `summary`
 * are always present (derived from the action/description when unauthored), the
 * rest stay optional. This is exactly the shape the registry stores on every
 * {@link RegisteredTool}, exported so the two never drift.
 */
export type ResolvedDiscovery = Required<Pick<ToolDiscoveryMetadata, "title" | "summary">> &
  ToolDiscoveryMetadata;

/**
 * Merge a derived discovery baseline with hand-authored overrides. Scalars
 * (`title`, `summary`) take the override when present, else the derived default.
 * Arrays are a de-duplicated union — an author supplies a small delta that
 * *improves* the baseline rather than forking it — with authored phrasings kept
 * first so they read as canonical. `relatedTools` is authored-only: the baseline
 * cannot know which exact companion tool is useful next.
 */
export function deriveToolDiscovery(input: DeriveToolDiscoveryInput): ResolvedDiscovery {
  const overrides = input.overrides ?? {};
  const tokens = actionTokens(input.action);
  const [lead, ...rest] = tokens;

  const derivedVerbs = lead ? [lead, ...(VERB_SYNONYMS[lead] ?? [])] : [];
  const derivedEntities = [...entitiesFromTokens(rest), ...schemaFieldEntities(input.inputSchema)];
  const humanizedAction = humanizeSlug(input.action).toLowerCase();
  const qualifiedAlias = `${input.integration} ${humanizedAction}`;
  // A single-token action ("search", "redeploy") humanizes to one bare word that
  // many providers share, so as an *exact* alias it would force-preload every
  // sibling holding that word at the top score tier on a one-word prompt. Keep
  // the bare form only for multi-token actions ("create event"), which are
  // specific; a lone verb stays reachable via `verbs` and the qualified alias.
  const derivedAliases = tokens.length > 1 ? [humanizedAction, qualifiedAlias] : [qualifiedAlias];

  return {
    title: overrides.title ?? humanizeSlug(input.action),
    summary: overrides.summary ?? input.description,
    aliases: union(overrides.aliases, derivedAliases),
    tags: union(overrides.tags, [input.integration]),
    entities: union(overrides.entities, derivedEntities),
    verbs: union(overrides.verbs, derivedVerbs),
    ...(overrides.relatedTools ? { relatedTools: overrides.relatedTools } : {}),
  };
}

function actionTokens(action: string): string[] {
  return action
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Turn raw tokens — from an action's trailing words or a schema field name —
 * into entity phrases: drop too-short connector noise (`by`, `to`, `id`), then
 * expand each survivor to its number forms. Both token sources route through
 * here so an arbitrary MCP tool name (`get_item_by_id`) can't leak `by`/`id` as
 * entities any more than a schema field can. Schema-field *plumbing* (pagination,
 * request options) is a field-name concern, filtered by the caller before this —
 * a word like `page` is noise in `pageToken` but a real entity in `create_page`.
 */
function entitiesFromTokens(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    if (token.length <= 2) continue;
    out.push(...entityForms(token));
  }
  return out;
}

/** A noun token plus its naive singular, so a query matches either number. */
function entityForms(token: string): string[] {
  const singular = singularize(token);
  return singular === token ? [token] : [token, singular];
}

function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !/(ss|us|is|ous)$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * Singularize each word of a normalized phrase. Search/preload matching (#414)
 * reduces both the query and every catalog phrase to this form so a plural
 * prompt ("my pull requests") matches a singular authored entity ("pull
 * request") and vice versa. It reuses {@link singularize} word-by-word rather
 * than reimplementing the rules, so the matcher and the derived-entity forms
 * share one notion of "singular" and cannot drift. Expects an already-normalized,
 * single-spaced string (see the discovery ranker's `normalize`).
 */
export function singularizePhrase(value: string): string {
  return value.split(" ").map(singularize).join(" ");
}

/**
 * Meaningful nouns from the schema's top-level fields. Read through zod's own
 * JSON-Schema conversion — like the dispatcher's accepted-key view, but with
 * boot-safe options (`reused: "inline"` so wrapped schemas still report their
 * inner object, `unrepresentable: "any"` so an exotic field can't throw) — since
 * this runs at registration, where any conversion failure degrades to no fields
 * rather than aborting boot.
 */
function schemaFieldEntities(schema: z.ZodTypeAny): string[] {
  let json: Record<string, unknown>;
  try {
    json = z.toJSONSchema(schema, {
      io: "input",
      reused: "inline",
      unrepresentable: "any",
    }) as Record<string, unknown>;
  } catch {
    return [];
  }
  const properties = json.properties;
  if (!properties || typeof properties !== "object") return [];
  const fieldTokens = Object.keys(properties)
    .flatMap(splitFieldName)
    .filter((token) => !PLUMBING_FIELD_TOKENS.has(token));
  return entitiesFromTokens(fieldTokens);
}

/** `spreadsheetId` → `["spreadsheet", "id"]`; `page_token` → `["page", "token"]`. */
function splitFieldName(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Case-insensitive de-duplicated union; `primary` phrasings come first. */
function union(primary: readonly string[] | undefined, derived: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...(primary ?? []), ...derived]) {
    const trimmed = value.trim();
    const dedupeKey = trimmed.toLowerCase();
    if (trimmed.length === 0 || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(trimmed);
  }
  return out;
}
