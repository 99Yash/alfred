/**
 * Time-to-first-token probe for the chat boss turn. Langfuse records only full-call
 * latency, so this streams the real model with the real tool schemas and times the
 * first chunk, with tools on and off, per model route. It calls the AI SDK
 * directly, so it measures the model, not the agent loop.
 *
 * Run locally from apps/server (needs the model keys and serverEnv vars):
 *   ./node_modules/.bin/tsx --env-file=.env src/scripts/probes/probe-chat-ttft.ts
 * Tune with PROBE_RUNS (default 3), PROBE_MODELS (default "haiku,boss,opus"),
 * PROBE_MAX_OUT (default 400).
 */
import {
  route,
  streamText,
  tool,
  type LanguageModel,
  type ModelRouteHandle,
  type Tool,
  type ToolSet,
} from "@alfred/ai";
import { registerBuiltinTools } from "@alfred/assistant/tool-runtime/builtin-tools";
import { INTEGRATION_SLUGS } from "@alfred/contracts";

// Real `route()` handles, so provider options and reasoning settings match prod.
// The map keys are labels only; each route resolves to whatever model it uses today.
type ChatProviderOptions = ReturnType<ModelRouteHandle["providerOptions"]>;

const MODELS = new Map<string, () => ModelRouteHandle>([
  ["haiku", () => route("standard")],
  ["boss", () => route("boss")],
  ["opus", () => route("deep")],
]);

const SELECTED = (process.env.PROBE_MODELS ?? "haiku,boss,opus")
  .split(",")
  .map((s) => s.trim())
  .filter((m) => MODELS.get(m));

const RUNS = Number(process.env.PROBE_RUNS ?? "3");

const MAX_OUT = Number(process.env.PROBE_MAX_OUT ?? "400");

/** A real prod ask that fans out across integrations when tools exist. */
const USER_PROMPT = "enlist the activities across all of my integrations in the last 24 hours";

/** A constant boss-sized system block, so only the tools and model vary. */
const SYSTEM_PROMPT = [
  "You are Alfred, a personal AI assistant operating over the user's connected integrations.",
  "Answer in the user's voice, be concise, and prefer acting (calling tools) over asking.",
  "When a request spans multiple integrations, fan out the relevant searches in parallel in a single turn.",
  "Ground every factual claim in a tool result; never invent data you did not retrieve.",
  ...Array.from(
    { length: Number(process.env.PROBE_SYS_LINES ?? "80") },
    (_, i) =>
      `Operating guideline ${i}: respect standing instructions, surface only what matters, ` +
      `attribute information to its source, and keep narration short while tools are running.`,
  ),
].join("\n");

/** The full tool menu: system plus every loadable integration. */
function buildAllTools() {
  const registry = registerBuiltinTools(); // server boot normally does this
  const out: Record<string, Tool> = {};

  for (const slug of INTEGRATION_SLUGS) {
    for (const r of registry.listForIntegration(slug)) {
      out[r.name] = tool({ description: r.description, inputSchema: r.inputSchema });
    }
  }

  // SAFETY: the resolved map is a name-to-tool record, which is what ToolSet is.
  return { tools: out as ToolSet, count: Object.keys(out).length };
}

interface Sample {
  ttftMs: number; // first chunk of any kind
  firstTextMs: number | null;
  firstToolMs: number | null;
  totalMs: number;
  outTokens: number;
  toolCalls: number;
}

const isContent = (t: string) =>
  /delta|tool-call|tool-input|^text|^reasoning/.test(t) && !t.startsWith("start");

async function once(
  model: LanguageModel,
  tools: ToolSet | undefined,
  thinking?: ChatProviderOptions,
): Promise<Sample> {
  const t0 = performance.now();
  let ttft: number | null = null;
  let firstText: number | null = null;
  let firstTool: number | null = null;
  let toolCalls = 0;

  const res = streamText({
    model,
    instructions: SYSTEM_PROMPT,
    messages: [{ role: "user", content: USER_PROMPT }],
    ...(tools ? { tools } : {}),
    maxOutputTokens: MAX_OUT,
    temperature: 0,
    // Like prod: the route's reasoning options plus prompt caching.
    providerOptions: {
      ...thinking,
      anthropic: { ...thinking?.anthropic, cacheControl: { type: "ephemeral" } },
    },
  });

  for await (const part of res.stream) {
    const now = performance.now();
    const type: string = part.type;

    if (ttft === null && isContent(type)) ttft = now - t0;

    if (firstText === null && (type === "text-delta" || type === "text")) firstText = now - t0;

    if (firstTool === null && (type === "tool-call" || type === "tool-input-start")) {
      firstTool = now - t0;
    }

    if (type === "tool-call") toolCalls++;
  }

  const totalMs = performance.now() - t0;
  const usage = await res.usage;

  return {
    ttftMs: ttft ?? totalMs,
    firstTextMs: firstText,
    firstToolMs: firstTool,
    totalMs,
    outTokens: usage.outputTokens ?? 0,
    toolCalls,
  };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

async function condition(
  label: string,
  model: LanguageModel,
  tools: ToolSet | undefined,
  thinking?: ChatProviderOptions,
): Promise<void> {
  await once(model, tools, thinking).catch(() => null); // warm the prompt cache
  const samples: Sample[] = [];

  for (let i = 0; i < RUNS; i++) samples.push(await once(model, tools, thinking));

  const med = (pick: (s: Sample) => number | null) =>
    median(samples.map(pick).filter((n): n is number => n != null));

  const decodeRate = (() => {
    const rates = samples
      .filter((s) => s.totalMs > s.ttftMs && s.outTokens > 0)
      .map((s) => (s.outTokens / (s.totalMs - s.ttftMs)) * 1000);

    return rates.length ? median(rates) : 0;
  })();

  console.log(
    `${label.padEnd(34)} ttft=${med((s) => s.ttftMs)
      .toFixed(0)
      .padStart(5)}ms  ` +
      `first_tool=${(med((s) => s.firstToolMs) ?? 0).toFixed(0).padStart(5)}ms  ` +
      `total=${med((s) => s.totalMs)
        .toFixed(0)
        .padStart(6)}ms  ` +
      `out=${med((s) => s.outTokens)
        .toFixed(0)
        .padStart(4)}tok  ` +
      `decode=${decodeRate.toFixed(0).padStart(3)}tok/s  ` +
      `tools_called=${median(samples.map((s) => s.toolCalls))}`,
  );
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const { tools, count } = buildAllTools();
  console.log(
    `# Chat TTFT probe — runs=${RUNS} (median), maxOut=${MAX_OUT}, fullToolMenu=${count} tools\n` +
      `# prompt: "${USER_PROMPT}"\n`,
  );

  for (const m of SELECTED) {
    const make = MODELS.get(m);

    if (!make) continue;
    const modelRoute = make();
    await condition(`${m} · no tools`, modelRoute.model(), undefined, modelRoute.providerOptions());
    await condition(
      `${m} · ${count} tools (prod-like)`,
      modelRoute.model(),
      tools,
      modelRoute.providerOptions(),
    );
  }

  console.log(
    "\n# Read: if ttft ≈ total and tools inflate ttft → the 7s is the model ingesting the\n" +
      "# tool schemas before first token (lever = shrink the menu). If decode tok/s is low and\n" +
      "# total ≫ ttft → it's generation, not first-token (lever = model / fewer output tokens).\n" +
      "# For the opus (Deep) tier, first_tool ≫ ttft means reasoning tokens emitted BEFORE the\n" +
      "# first tool call — the 'thinking before tools' symptom (lever = lower effort / fewer turns).",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
