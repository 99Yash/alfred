import { httpErrorFromResponse } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { z } from "zod";
import {
  BATCH_CHARS_PER_TOKEN,
  EMBEDDING_DIMENSIONS,
  VOYAGE_INPUT_PRICE_PER_MTOK_USD_DEFAULT,
  VOYAGE_MAX_BATCH_INPUTS,
  VOYAGE_MAX_BATCH_TOKENS,
} from "./constants";
import { metered } from "./metering/metered";

export {
  EMBEDDING_DIMENSIONS,
  VOYAGE_MAX_BATCH_INPUTS,
  VOYAGE_MAX_BATCH_TOKENS,
} from "./constants";

import type { CallAttribution } from "./metering/metered";

// Voyage embeddings at 1024 dimensions, one model for indexing and queries (ADR-0021).

/** The price the embed cost cap uses. */
export function voyageInputPricePerMtokUsd(): number {
  return serverEnv().VOYAGE_INPUT_PRICE_PER_MTOK_USD ?? VOYAGE_INPUT_PRICE_PER_MTOK_USD_DEFAULT;
}

const VOYAGE_API_BASE = "https://api.voyageai.com/v1/embeddings";

const VOYAGE_DEFAULT_MODEL = "voyage-3.5";

/** Voyage encodes indexed text and search queries differently. It matters for retrieval quality. */
export type EmbeddingInputType = "document" | "query";

export interface EmbedOptions extends CallAttribution {
  /** Defaults to `voyage-3.5`. */
  model?: string;
  /** Defaults to `document`. */
  inputType?: EmbeddingInputType;
  dimensions?: number;
  idempotencyKey?: string;
  abortSignal?: AbortSignal;
}

interface VoyageEmbeddingResponse {
  object: "list";
  data: Array<{ embedding: number[]; index: number; object: "embedding" }>;
  model: string;
  usage: { total_tokens: number };
}

const voyageEmbeddingResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(
    z.object({
      embedding: z.array(z.number()),
      index: z.number(),
      object: z.literal("embedding"),
    }),
  ),
  model: z.string(),
  usage: z.object({ total_tokens: z.number() }),
});

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

      const parsed = voyageEmbeddingResponseSchema.safeParse(await res.json());

      if (!parsed.success) {
        throw new Error("[embeddings] Voyage returned an unexpected payload shape");
      }

      return parsed.data;
    },
    (result) => ({
      usage: { inputTokens: result.usage.total_tokens, outputTokens: 0 },
      responseMeta: { model: result.model, returned: result.data.length },
    }),
  );
}

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
 * Split into batches within Voyage's limits.
 * One text over the token limit gets its own batch, and Voyage rejects it.
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

/** One metered Voyage call per batch, in sequence. Vectors keep input order. */
export async function embedMany(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
  if (texts.length === 0) return [];
  const filtered = texts.map((t) => (t.length === 0 ? " " : t));
  const out: number[][] = [];

  for (const batch of batchForVoyage(filtered)) {
    const response = await callVoyage(batch, opts);
    // Voyage returns them in order today; sort anyway.
    const sorted = [...response.data].sort((a, b) => a.index - b.index);
    out.push(...sorted.map((d) => d.embedding));
  }

  return out;
}
