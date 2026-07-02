/**
 * Live web search for the boss / sub-agents (ADR-0022, amended 2026-06-12).
 * Backed by grounded Gemini 2.5 Flash via `getWebSearchModel()` +
 * `googleSearchGroundingTools()` — the model runs Google Search server-side
 * and returns a short, citation-grounded answer rather than a raw SERP, so the
 * boss can fold it straight into its turn. (Swapped off Perplexity Sonar Pro
 * when that account lost billing; Gemini grounding rides the key we already
 * hold.)
 *
 * Every call routes through `meteredGenerateText` with
 * `attribution.kind = 'web_search'` so `api_call_log` rollups bucket the spend
 * apart from ordinary LLM turns. Cold-start's bounded research loops call this
 * same function (see `cold-start/web-tool.ts`) so their searches meter the same
 * way.
 */

import { getWebSearchModel, googleSearchGroundingTools, meteredGenerateText } from "@alfred/ai";
import { getPath, isNonEmptyString, isRecord } from "@alfred/contracts";

export interface WebSearchArgs {
  query: string;
  userId: string;
  /** Optional — attribution columns are nullable; omit rather than pass "". */
  runId?: string;
  stepId?: string;
  /** Stable per-call key — the tool passes the model's tool_call_id. */
  idempotencyKey?: string;
  abortSignal?: AbortSignal;
}

export interface WebSearchSource {
  /**
   * The link to follow. For Gemini grounding this is a `vertexaisearch.cloud.
   * google.com` redirect that resolves to the real publisher when opened — it
   * is *not* a clean publisher URL, so don't derive a display domain from it.
   */
  url: string;
  /**
   * The publisher's name as grounding reports it — usually the bare domain
   * ("cloudflare.com", "en.wikipedia.org"). Present for grounded results;
   * absent only when the metadata is malformed. Prefer this for display and
   * favicon lookup, since {@link url} is an opaque redirect.
   */
  title?: string;
}

export interface WebSearchResult {
  answer: string;
  citations: WebSearchSource[];
  /**
   * The Google Search queries the grounded model actually ran server-side
   * (`groundingMetadata.webSearchQueries`), when it reports them. Surfaced so a
   * caller can see how its question was interpreted and vary the angle on a
   * follow-up instead of repeating the same search. Best-effort — empty when
   * grounding didn't report it.
   */
  searchQueries: string[];
}

function buildPrompt(query: string): string {
  return [
    "You are a live web search assistant for a personal AI agent that will act on what you return. Search the web and report what you actually find for the query below — your job is to surface findings, not to gate them behind a confidence bar.",
    "",
    "Guidelines:",
    "- Report what the results show. If the search surfaces plausible candidate matches, name them and say what each source indicates (role, employer, location, dates, handles), even when you're not fully certain — flag the uncertainty instead of withholding the finding.",
    '- Do not answer "no confident match" when the search returned relevant results. Reserve "nothing found" for when the search genuinely turns up nothing on point; a weak or partial hit is still a result — surface it.',
    "- When a name or entity is ambiguous, list the distinct candidates and what tells them apart rather than silently picking one or dropping them all.",
    "- Attribute claims to the sources you used with inline numeric markers ([1], [2], …). Prefer primary/official sources, but include useful profiles and company team/about pages when they're the best available.",
    "- Be factual and concise. Lead with the substance; no preamble or meta-commentary.",
    "",
    `Query: ${query}`,
  ].join("\n");
}

/**
 * Pull the actual Google Search queries out of the grounding metadata
 * (`providerMetadata.google.groundingMetadata.webSearchQueries`). Best-effort,
 * same as {@link extractCitations} — tolerate missing/wrong-shape data.
 */
function extractSearchQueries(providerMetadata: unknown): string[] {
  const queries = getPath(providerMetadata, "google", "groundingMetadata", "webSearchQueries");
  if (!Array.isArray(queries)) return [];
  return queries.filter((q): q is string => isNonEmptyString(q));
}

/**
 * Pull `{ url, title }` sources out of the AI SDK result. Gemini grounding
 * surfaces them two ways, both of which we read and dedupe by url (order-
 * preserving):
 *   1. `result.sources` — the v6 standard `url`-typed source parts the SDK
 *      lifts out of grounding chunks (each carries `url` + `title`).
 *   2. `providerMetadata.google.groundingMetadata.groundingChunks[].web`
 *      — the raw grounding payload (`uri` + `title`), in case the SDK didn't
 *      lift a chunk.
 * Both report the same shape: the `url`/`uri` is a vertex redirect and the
 * `title` is the real publisher domain — so we keep the title for display.
 * Extraction is best-effort — tolerate missing or wrong-shape data gracefully
 * (it's observability, not correctness).
 */
function extractCitations(
  sources: ReadonlyArray<{ url?: string; title?: string }> | undefined,
  providerMetadata: unknown,
): WebSearchSource[] {
  const seen = new Set<string>();
  const out: WebSearchSource[] = [];
  const push = (url: unknown, title: unknown): void => {
    if (isNonEmptyString(url) && !seen.has(url)) {
      seen.add(url);
      out.push({ url, title: isNonEmptyString(title) ? title : undefined });
    }
  };

  if (Array.isArray(sources)) {
    for (const s of sources) push(s?.url, s?.title);
  }

  const chunks = getPath(providerMetadata, "google", "groundingMetadata", "groundingChunks");
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) {
      const web = getPath(chunk, "web");
      if (isRecord(web)) push(web.uri, web.title);
    }
  }

  return out;
}

export async function runWebSearch(args: WebSearchArgs): Promise<WebSearchResult> {
  const result = await meteredGenerateText(
    {
      model: getWebSearchModel(),
      // Google runs the search server-side inside this single generation —
      // there's no client-side tool round trip to step through, so the
      // grounded answer lands directly in `result.text`.
      tools: googleSearchGroundingTools(),
      prompt: buildPrompt(args.query),
      // ~2.5k gives room to list a few candidate matches with what each source
      // says (the old 1.5k pushed the model to collapse to a one-line verdict —
      // the "no confident match" punt this tool used to return), while still
      // holding a single interactive lookup cheap.
      maxOutputTokens: 2_500,
      temperature: 0,
      abortSignal: args.abortSignal,
    },
    {
      kind: "web_search",
      userId: args.userId,
      runId: args.runId,
      stepId: args.stepId,
      idempotencyKey: args.idempotencyKey,
      requestMeta: { purpose: "agent.web_search" },
      name: "agent.web_search",
    },
  );

  return {
    answer: result.text.trim(),
    citations: extractCitations(
      result.sources as ReadonlyArray<{ url?: string; title?: string }> | undefined,
      result.providerMetadata,
    ),
    searchQueries: extractSearchQueries(result.providerMetadata),
  };
}
