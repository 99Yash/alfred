/**
 * Live verification for the lossy-generation fix (captureOutput).
 *
 * Before: a tool-call turn captured `result.text` only — empty on a no-prose
 * tool call — so the generation's `output` landed NULL and a replay lost what
 * the model decided to call. This drives a REAL `meteredGenerateText` with
 * `toolChoice: 'required'` (guarantees a no-prose tool-call turn), flushes to
 * Langfuse, and asserts the generation output now carries the tool call.
 *
 * Reads go through `GET /api/public/v2/observations` (filtered by trace id)
 * because the self-hosted `events_only` write mode serves reads from the v2
 * observations API and 404s the legacy `GET /api/public/traces/:id`.
 *
 * Run from packages/ai (needs a cheap-model key + LANGFUSE_* in env):
 *   ./node_modules/.bin/tsx --env-file=../../apps/server/.env \
 *     src/scripts/verify-capture-output.ts
 */
import { serverEnv } from "@alfred/env/server";
import { isRecord } from "@alfred/contracts";
import { jsonSchema, tool, type ToolSet } from "ai";
import { randomUUID } from "node:crypto";
import { flushLangfuse, langfuseTraceId } from "../metering/langfuse";
import { route } from "../provider";
import { meteredGenerateText } from "../metering/wrappers";
import {
  decodeLangfuseIo,
  fetchObservationsByTraceId,
  type LangfuseObservation,
} from "./langfuse-observations";

const stamp = randomUUID().slice(0, 8);

const runId = `verify_capture_${stamp}`;

const GENERATE_TIMEOUT_MS = 60_000;

const LANGFUSE_FETCH_TIMEOUT_MS = 10_000;

const weather = tool({
  description: "Get the current weather for a city.",
  inputSchema: jsonSchema<{ city: string }>({
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  }),
});

// `tool()` returns `Tool<INPUT>`, which under `exactOptionalPropertyTypes` is no
// longer assignable to the SDK's own `ToolSet`: bare `Tool` fixes `INPUT` to
// `never`, and the flag removes the optional-property slack that used to let the
// two unify. The cast is that SDK variance gap, not a claim about this tool.
// eslint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- boundary cast: source type is structurally incompatible with target
const tools = { weather } as unknown as ToolSet;

function toolCallCount(metadata: unknown): number {
  const decoded = decodeLangfuseIo(metadata);

  return isRecord(decoded) && typeof decoded.toolCallCount === "number" ? decoded.toolCallCount : 0;
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
      model: route("cheap").model(),
      prompt: "What's the weather in Paris?",
      tools,
      toolChoice: "required",
      timeout: GENERATE_TIMEOUT_MS,
    },
    { runId, role: "boss", name: "agent:chat", userId: "verify-user" },
  );

  console.log(
    `[verify] turn finished: text=${JSON.stringify(result.text)} toolCalls=${result.toolCalls.length}`,
  );
  await flushLangfuse();

  // Poll the trace until the generation observation materializes.
  let gen: LangfuseObservation | undefined;

  for (let attempt = 1; attempt <= 20; attempt++) {
    const observations = await fetchObservationsByTraceId({
      host,
      auth,
      traceId: langfuseTraceId(runId),
      timeoutMs: LANGFUSE_FETCH_TIMEOUT_MS,
    });

    gen = observations.find((o) => o.type === "GENERATION" && toolCallCount(o.metadata) > 0);

    if (gen) break;

    process.stdout.write(`  poll ${attempt}/20\r`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log("");

  if (!gen) {
    console.log("❌ no tool-call generation observation appeared");
    process.exit(1);
  }

  const out = decodeLangfuseIo(gen.output);
  const calls = isRecord(out) ? out.toolCalls : undefined;
  const ok = Array.isArray(calls) && calls.length > 0 && typeof calls[0]?.toolName === "string";
  console.log(`generation output: ${JSON.stringify(out)?.slice(0, 300)}`);
  console.log(
    ok
      ? `\n✅ tool call captured in generation output (toolName=${calls[0]!.toolName})`
      : "\n❌ generation output did NOT carry the tool call (regression — was NULL before the fix)",
  );
  process.exit(ok ? 0 : 1);
}

void main();
