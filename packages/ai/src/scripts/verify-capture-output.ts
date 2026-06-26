/**
 * Live verification for the lossy-generation fix (captureOutput).
 *
 * Before: a tool-call turn captured `result.text` only — empty on a no-prose
 * tool call — so the generation's `output` landed NULL and a replay lost what
 * the model decided to call. This drives a REAL `meteredGenerateText` with
 * `toolChoice: 'required'` (guarantees a no-prose tool-call turn), flushes to
 * Langfuse, and asserts the generation output now carries the tool call.
 *
 * Run from packages/ai (needs a cheap-model key + LANGFUSE_* in env):
 *   ./node_modules/.bin/tsx --env-file=../../apps/server/.env \
 *     src/scripts/verify-capture-output.ts
 */
import { serverEnv } from "@alfred/env/server";
import { jsonSchema, tool } from "ai";
import { randomUUID } from "node:crypto";
import { flushLangfuse } from "../metering/langfuse";
import { getCheapModel } from "../provider";
import { meteredGenerateText } from "../metering/wrappers";

const stamp = randomUUID().slice(0, 8);
const runId = `verify_capture_${stamp}`;

const weather = tool({
  description: "Get the current weather for a city.",
  inputSchema: jsonSchema<{ city: string }>({
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  }),
});

interface Obs {
  type: string;
  name: string;
  output?: unknown;
  metadata?: { toolCallCount?: number; finishReason?: string };
}

async function main() {
  const env = serverEnv();
  if (!env.LANGFUSE_CAPTURE_IO) {
    throw new Error("LANGFUSE_CAPTURE_IO must be true to verify captured output");
  }
  const host = env.LANGFUSE_HOST ?? "https://cloud.langfuse.com";
  const auth = Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString(
    "base64",
  );

  console.log(`[verify] forcing a tool-call turn (runId=${runId})`);
  const result = await meteredGenerateText(
    {
      model: getCheapModel(),
      prompt: "What's the weather in Paris?",
      tools: { weather },
      toolChoice: "required",
    },
    { runId, role: "boss", name: "agent:chat", userId: "verify-user" },
  );
  console.log(
    `[verify] turn finished: text=${JSON.stringify(result.text)} toolCalls=${result.toolCalls.length}`,
  );
  await flushLangfuse();

  // Poll the trace until the generation observation materializes.
  let gen: Obs | undefined;
  for (let attempt = 1; attempt <= 20; attempt++) {
    const res = await fetch(`${host}/api/public/traces/${runId}`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (res.ok) {
      const t = (await res.json()) as { observations?: Obs[] };
      gen = (t.observations ?? []).find(
        (o) => o.type === "GENERATION" && (o.metadata?.toolCallCount ?? 0) > 0,
      );
      if (gen) break;
    }
    process.stdout.write(`  poll ${attempt}/20\r`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log("");

  if (!gen) {
    console.log("❌ no tool-call generation observation appeared");
    process.exit(1);
  }
  const out = gen.output as { toolCalls?: { toolName: string }[] } | string | null;
  const calls = typeof out === "object" && out !== null ? out.toolCalls : undefined;
  const ok = Array.isArray(calls) && calls.length > 0 && typeof calls[0]?.toolName === "string";
  console.log(`generation output: ${JSON.stringify(out)?.slice(0, 300)}`);
  console.log(
    ok
      ? `\n✅ tool call captured in generation output (toolName=${calls![0]!.toolName})`
      : "\n❌ generation output did NOT carry the tool call (regression — was NULL before the fix)",
  );
  process.exit(ok ? 0 : 1);
}

void main();
