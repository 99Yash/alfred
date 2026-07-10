import { closeConnections, db } from "@alfred/db";
import { apiCallLog } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { toMessage } from "@alfred/contracts";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { isStepCount, tool } from "ai";
import { z } from "zod";
import {
  getRegisteredModel,
  getRegisteredModelProviderOptions,
  flushMeteringWrites,
  meteredGenerateObject,
  meteredGenerateText,
  meteredStreamText,
  type ModelId,
} from "../index";

const MODEL_IDS = ["gpt-5.6-sol", "gpt-5.6-luna"] as const satisfies readonly ModelId[];

async function smokeModel(modelId: (typeof MODEL_IDS)[number]): Promise<void> {
  const model = getRegisteredModel(modelId);
  const providerOptions = getRegisteredModelProviderOptions(modelId, "medium");
  const attribution = { requestMeta: { smoke: "gpt-5.6", surface: modelId } } as const;

  const text = await meteredGenerateText(
    {
      model,
      providerOptions,
      prompt: "Reply with exactly: text-ok",
      maxOutputTokens: 32,
    },
    attribution,
  );
  if (!text.text.toLowerCase().includes("text-ok")) {
    throw new Error(`${modelId} non-streaming text mismatch: ${text.text}`);
  }

  const stream = meteredStreamText(
    {
      model,
      providerOptions,
      prompt: "Reply with exactly: stream-ok",
      maxOutputTokens: 32,
    },
    attribution,
  );
  for await (const _part of stream.stream) {
    // Draining the real stream triggers final usage + metering.
  }
  const streamedText = await stream.text;
  if (!streamedText.toLowerCase().includes("stream-ok")) {
    throw new Error(`${modelId} streaming text mismatch: ${streamedText}`);
  }

  const toolResult = await meteredGenerateText(
    {
      model,
      providerOptions,
      prompt: "Call the lookup tool once with query 'alfred'. Do not answer in prose.",
      tools: {
        "smoke.lookup": tool({
          description: "Look up a smoke-test query.",
          inputSchema: z.object({ query: z.string() }),
        }),
      },
      toolChoice: { type: "tool", toolName: "smoke.lookup" },
      stopWhen: isStepCount(1),
      maxOutputTokens: 64,
    },
    attribution,
  );
  if (toolResult.toolCalls[0]?.toolName !== "smoke.lookup") {
    throw new Error(`${modelId} dotted tool did not round-trip`);
  }

  const objectResult = await meteredGenerateObject(
    {
      model,
      providerOptions,
      prompt: "Return status ok and model equal to the model identifier in this prompt: " + modelId,
      schema: z.object({ status: z.literal("ok"), model: z.literal(modelId) }),
      schemaName: "gpt_5_6_smoke",
      maxOutputTokens: 64,
    },
    attribution,
  );
  if (objectResult.output.status !== "ok" || objectResult.output.model !== modelId) {
    throw new Error(`${modelId} structured output mismatch`);
  }

  const firstTurn = await meteredGenerateText(
    {
      model,
      providerOptions,
      prompt: "Remember the nonce cedar-47. Reply only: remembered",
      maxOutputTokens: 32,
    },
    attribution,
  );
  const replay = await meteredGenerateText(
    {
      model,
      providerOptions,
      messages: [
        { role: "user", content: "Remember the nonce cedar-47. Reply only: remembered" },
        ...firstTurn.responseMessages,
        { role: "user", content: "What nonce did I ask you to remember? Reply with it only." },
      ],
      maxOutputTokens: 32,
    },
    attribution,
  );
  if (!replay.text.toLowerCase().includes("cedar-47")) {
    throw new Error(`${modelId} multi-turn transcript replay mismatch: ${replay.text}`);
  }

  console.log(`[smoke-gpt-5.6] ${modelId}: text, stream, tool, object, replay OK`);
}

async function main(): Promise<void> {
  if (!serverEnv().OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
  const startedAt = new Date();
  for (const modelId of MODEL_IDS) await smokeModel(modelId);

  // Metering stays fire-and-forget on request paths; scripts can drain it deterministically.
  await flushMeteringWrites();
  const rows = await db()
    .select({ model: apiCallLog.model, costUsd: apiCallLog.costUsd })
    .from(apiCallLog)
    .where(
      and(
        eq(apiCallLog.provider, "openai"),
        inArray(apiCallLog.model, [...MODEL_IDS]),
        gte(apiCallLog.createdAt, startedAt),
      ),
    )
    .orderBy(desc(apiCallLog.id));
  for (const modelId of MODEL_IDS) {
    const modelRows = rows.filter((row) => row.model === modelId);
    if (modelRows.length < 6 || !modelRows.every((row) => Number(row.costUsd) > 0)) {
      throw new Error(`${modelId} metering rows missing or unpriced`);
    }
  }
  console.log(`[smoke-gpt-5.6] metering OK (${rows.length} priced rows)`);
}

main()
  .catch((error) => {
    console.error("[smoke-gpt-5.6] FAIL", toMessage(error));
    process.exitCode = 1;
  })
  .finally(() => closeConnections().catch(() => {}));
