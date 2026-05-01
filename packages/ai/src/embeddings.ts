import { serverEnv } from "@alfred/env/server";
import { metered } from "./metering/metered";
import type { CallAttribution } from "./metering/types";

/**
 * Embedding API for the alfred corpus.
 *
 * Per ADR-0021: Voyage family at 1024 dim, cosine distance, primary for
 * both ingestion and query. m7b ships a single Voyage model
 * (`voyage-3.5`) for both sides; voyage-context-3 (contextualized
 * embeddings) is layered in later when the corpus is large enough that
 * neighbour-context matters.
 *
 * Gemini fallback is acknowledged in the ADR but deferred until the
 * Voyage path is exercised — Gemini's native 768-dim output requires a
 * separate index column, which is more migration than the milestone
 * needs.
 */

export const EMBEDDING_DIMENSIONS = 1024;

const VOYAGE_API_BASE = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_DEFAULT_MODEL = "voyage-3.5";

/**
 * `input_type` distinguishes how Voyage encodes the text:
 *   - `document` — the text being indexed (passages, emails, docs).
 *   - `query`    — the search query at retrieval time.
 *
 * Same model, different prompt template; matters for retrieval quality.
 */
export type EmbeddingInputType = "document" | "query";

export interface EmbedOptions extends CallAttribution {
  /** Voyage model id; defaults to `voyage-3.5`. */
  model?: string;
  /** `document` for ingestion, `query` for search. Defaults to `document`. */
  inputType?: EmbeddingInputType;
  /** Override the dimensions; only meaningful for models that support it. */
  dimensions?: number;
  /** Forwarded to `metered()` for cost attribution + Langfuse spans. */
  idempotencyKey?: string;
}

interface VoyageEmbeddingResponse {
  object: "list";
  data: Array<{ embedding: number[]; index: number; object: "embedding" }>;
  model: string;
  usage: { total_tokens: number };
}

async function callVoyage(
  texts: string[],
  opts: EmbedOptions,
): Promise<VoyageEmbeddingResponse> {
  const env = serverEnv();
  if (!env.VOYAGE_API_KEY) {
    throw new Error("[embeddings] VOYAGE_API_KEY missing — set it to use the embeddings module");
  }

  const model = opts.model ?? VOYAGE_DEFAULT_MODEL;
  const meta = {
    kind: "embedding" as const,
    provider: "voyage",
    model,
    userId: opts.userId,
    runId: opts.runId,
    stepId: opts.stepId,
    attempt: opts.attempt,
    messageId: opts.messageId,
    idempotencyKey: opts.idempotencyKey,
    requestMeta: {
      inputType: opts.inputType ?? "document",
      batchSize: texts.length,
      dimensions: opts.dimensions ?? EMBEDDING_DIMENSIONS,
    },
  };

  return metered(
    meta,
    async () => {
      const res = await fetch(VOYAGE_API_BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.VOYAGE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: texts,
          model,
          input_type: opts.inputType ?? "document",
          output_dimension: opts.dimensions ?? EMBEDDING_DIMENSIONS,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`[embeddings] Voyage ${res.status}: ${body.slice(0, 500)}`);
      }
      return (await res.json()) as VoyageEmbeddingResponse;
    },
    (result) => ({
      usage: { inputTokens: result.usage.total_tokens, outputTokens: 0 },
      responseMeta: { model: result.model, returned: result.data.length },
    }),
  );
}

/** Embed a single text. Returns a 1024-dim vector. */
export async function embed(text: string, opts: EmbedOptions = {}): Promise<number[]> {
  if (text.length === 0) {
    throw new Error("[embeddings] cannot embed empty string");
  }
  const response = await callVoyage([text], opts);
  const first = response.data[0];
  if (!first) throw new Error("[embeddings] Voyage returned no vectors");
  return first.embedding;
}

/**
 * Embed a batch in a single Voyage call. Voyage caps batches at 1000
 * inputs and 120k tokens total; callers above this should chunk
 * themselves and merge. For our scale (one user, paragraph-sized
 * chunks), one call per document covers it.
 */
export async function embedMany(
  texts: string[],
  opts: EmbedOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const filtered = texts.map((t) => (t.length === 0 ? " " : t));
  const response = await callVoyage(filtered, opts);
  // Voyage promises ordered output, but we sort defensively in case
  // their response ordering changes.
  const sorted = [...response.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}
