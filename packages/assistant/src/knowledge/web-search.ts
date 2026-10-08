/**
 * Live web search for the boss and sub-agents (ADR-0022): grounded Gemini via
 * `route("webSearch")`, which returns a short cited answer, not a SERP. Each call
 * meters as `web_search`, apart from ordinary LLM turns.
 */

import { route, googleSearchGroundingTools, meteredGenerateText } from "@alfred/ai";
import { getPath, isNonEmptyString, isRecord } from "@alfred/contracts";

export interface WebSearchArgs {
  query: string;
  userId: string;
  /** Omit rather than pass "". */
  runId?: string | undefined;
  stepId?: string | undefined;
  /** The tool passes the model's tool_call_id. */
  idempotencyKey?: string;
  abortSignal?: AbortSignal | undefined;
}

interface WebSearchSource {
  /** A `vertexaisearch.cloud.google.com` redirect. Do not derive a display domain from it. */
  url: string;
  /** Publisher name, usually the bare domain. Use this for display and favicons. */
  title?: string | undefined;
}

interface WebSearchHit {
  /** Open with `system.fetch_url`. */
  url: string;
  title?: string;
  /** Gemini grounding gives no snippets; left for future providers. */
  snippet?: string;
}

export interface WebSearchResult {
  answer: string;
  citations: WebSearchSource[];
  /** Grounding sources, so an agent can pick what to `fetch_url`. */
  results: WebSearchHit[];
  /** The queries Google actually ran, so a follow-up can vary its angle. Empty when not reported. */
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

/** Best effort: tolerates missing or wrong-shape data. */
function extractSearchQueries(providerMetadata: unknown): string[] {
  const queries = getPath(providerMetadata, "google", "groundingMetadata", "webSearchQueries");

  if (!Array.isArray(queries)) return [];

  return queries.filter((q): q is string => isNonEmptyString(q));
}

/**
 * `{ url, title }` sources from `result.sources` and the raw `groundingChunks`,
 * deduped by url in order. Best effort: this is observability, not correctness.
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
      model: route("webSearch").model(),
      // Google searches server-side in this one generation; no tool round trip.
      tools: googleSearchGroundingTools(),
      prompt: buildPrompt(args.query),
      // 1.5k pushed the model to a one-line "no confident match" verdict.
      maxOutputTokens: 2_500,
      temperature: 0,
      ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
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

  const citations = extractCitations(result.sources, result.finalStep.providerMetadata);

  return {
    answer: result.text.trim(),
    citations,
    results: citations.map((source) => ({
      url: source.url,
      ...(source.title ? { title: source.title } : {}),
    })),
    searchQueries: extractSearchQueries(result.finalStep.providerMetadata),
  };
}
