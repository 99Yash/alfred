/**
 * Live web search for the boss / sub-agents (ADR-0022). Backed by Perplexity
 * Sonar Pro via `getWebSearchModel()` — the synthesis-shaped, agent-driven
 * lookup path (its heavier sibling `sonar-deep-research` is reserved for the
 * async cold-start workflow). The model returns a short cited answer rather
 * than a raw SERP, so the boss can fold it straight into its turn.
 *
 * Every call routes through `meteredGenerateText` with
 * `attribution.kind = 'web_search'` so `api_call_log` rollups bucket the spend
 * apart from ordinary LLM turns (mirrors `cold-start/research.ts`).
 */

import { getWebSearchModel, meteredGenerateText } from "@alfred/ai";

export interface WebSearchArgs {
  query: string;
  userId: string;
  runId: string;
  stepId: string;
  /** Stable per-call key — the tool passes the model's tool_call_id. */
  idempotencyKey?: string;
}

export interface WebSearchResult {
  answer: string;
  citations: string[];
}

function buildPrompt(query: string): string {
  return [
    "You are a live web search assistant for a personal AI agent. Answer the query below using current web sources.",
    "",
    "Guidelines:",
    "- Be concise and factual. Lead with the answer; no preamble or meta-commentary.",
    "- Use inline numeric citation markers ([1], [2], …) tied to the sources you actually used.",
    "- Prefer primary/official sources over aggregators.",
    "- If you can't find a confident answer, say so plainly rather than padding with guesses.",
    "",
    `Query: ${query}`,
  ].join("\n");
}

/**
 * Pull source URLs out of the AI SDK result. Sonar surfaces them via
 * `result.sources` (the v6 standard shape); older provider versions stuffed
 * them under `providerMetadata.perplexity.citations`. Read both, dedupe,
 * preserve order. Citation extraction is best-effort — tolerate missing or
 * wrong-shape data gracefully.
 */
function extractCitations(
  sources: ReadonlyArray<{ url?: string }> | undefined,
  providerMetadata: unknown,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  if (Array.isArray(sources)) {
    for (const s of sources) {
      const url = typeof s?.url === "string" ? s.url : undefined;
      if (url && !seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
  }

  if (providerMetadata && typeof providerMetadata === "object") {
    const pp = (providerMetadata as Record<string, unknown>).perplexity;
    if (pp && typeof pp === "object") {
      const cites = (pp as Record<string, unknown>).citations;
      if (Array.isArray(cites)) {
        for (const c of cites) {
          if (typeof c === "string" && !seen.has(c)) {
            seen.add(c);
            out.push(c);
          }
        }
      }
    }
  }

  return out;
}

export async function runWebSearch(args: WebSearchArgs): Promise<WebSearchResult> {
  const result = await meteredGenerateText(
    {
      model: getWebSearchModel(),
      prompt: buildPrompt(args.query),
      // Sonar Pro is not a reasoning model, so the budget covers the answer
      // alone. ~1.5k keeps a cited paragraph or two comfortably while holding
      // a single interactive lookup well under a cent.
      maxOutputTokens: 1_500,
      temperature: 0,
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
      result.sources as ReadonlyArray<{ url?: string }> | undefined,
      result.providerMetadata,
    ),
  };
}
