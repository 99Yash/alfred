import { httpErrorFromResponse } from "@alfred/contracts";
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

/** Voyage 3.5 input price per million tokens — single owner for cost-cap math. */
export const VOYAGE_INPUT_PRICE_PER_MTOK_USD = 0.06;

/**
 * Voyage per-request batch limits: at most 1000 inputs and 120k total
 * tokens in one call. `embedMany` chunks callers above this into
 * multiple requests and merges the vectors.
 */
export const VOYAGE_MAX_BATCH_INPUTS = 1000;
export const VOYAGE_MAX_BATCH_TOKENS = 120_000;

/**
 * Character-based token estimate for batch sizing — the same 4 chars/token
 * heuristic the corpus chunker uses. The chunker cannot be imported here
 * (`@alfred/corpus` depends on `@alfred/ai`, not the reverse), so the
 * constant is mirrored; a drift only shifts where batch boundaries land,
 * never correctness, because Voyage's usage response stays authoritative
 * for metering.
 */
const BATCH_CHARS_PER_TOKEN = 4;

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
  /** Forwarded to the underlying fetch call. */
  abortSignal?: AbortSignal;
}

interface VoyageEmbeddingResponse {
  object: "list";
  data: Array<{ embedding: number[]; index: number; object: "embedding" }>;
  model: string;
  usage: { total_tokens: number };
}

async function callVoyage(texts: string[], opts: EmbedOptions): Promise<VoyageEmbeddingResponse> {
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
        ...(opts.abortSignal ? { signal: opts.abortSignal } : {}),
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
        throw await httpErrorFromResponse("embeddings", res, { url: "voyage/embeddings" });
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
 * Split texts into Voyage-legal batches: at most `VOYAGE_MAX_BATCH_INPUTS`
 * inputs and an estimated `VOYAGE_MAX_BATCH_TOKENS` total per batch. Pure:
 * never mutates the input. A single text over the token budget still gets
 * its own batch — the provider rejects it, and the caller's existing
 * failure handling owns that outcome.
 */
export function batchForVoyage(texts: readonly string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const text of texts) {
    const estimated = Math.ceil(text.length / BATCH_CHARS_PER_TOKEN);
    const currentFull =
      current.length >= VOYAGE_MAX_BATCH_INPUTS ||
      (current.length > 0 && tokens + estimated > VOYAGE_MAX_BATCH_TOKENS);
    if (currentFull) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(text);
    tokens += estimated;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Embed a batch, chunking into multiple Voyage calls when the input exceeds
 * the provider's per-request limits (1000 inputs, 120k tokens). Batches run
 * sequentially and vectors merge in input order. Each call is metered
 * separately, so cost attribution stays per-request.
 */
export async function embedMany(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
  if (texts.length === 0) return [];
  const filtered = texts.map((t) => (t.length === 0 ? " " : t));
  const out: number[][] = [];
  for (const batch of batchForVoyage(filtered)) {
    const response = await callVoyage(batch, opts);
    // Voyage promises ordered output within a request, but we sort
    // defensively in case their response ordering changes.
    const sorted = [...response.data].sort((a, b) => a.index - b.index);
    out.push(...sorted.map((d) => d.embedding));
  }
  return out;
}
