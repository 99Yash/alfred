/**
 * TTFT probe for the chat boss turn (issue: prod chat "5–7s thinking before
 * tool calls", 2026-06-28). Langfuse records only full-call latency, never
 * time-to-first-token, so we can't tell from traces whether the ~7s first turn
 * is slow-to-start (TTFT: model ingesting the system prompt + ~49 tool schemas)
 * or slow-decode (token generation). This probe streams the real model with the
 * REAL tool schemas and timestamps the first chunk to split the two, sweeping
 * tools-on/off and Haiku/Sonnet so the cause is isolated, not guessed.
 *
 * Direct AI-SDK streaming call — deliberately bypasses AlfredAgent/withFallback
 * so we measure raw model latency, not orchestration. Uses the real tool
 * registry (`listToolsForIntegration`) so the tool-schema bulk is faithful.
 *
 * Run locally (needs ANTHROPIC_API_KEY + serverEnv vars):
 *   ./node_modules/.bin/tsx --env-file=.env src/scripts/probe-chat-ttft.ts
 * (from apps/server). Tune with PROBE_RUNS (default 3), PROBE_MODELS
 * ("haiku,sonnet"), PROBE_MAX_OUT (default 400).
 */
import {
  getBossModel,
  getChatModel,
  getChatProviderOptions,
  streamText,
  tool,
  type LanguageModel,
  type Tool,
  type ToolSet,
} from "@alfred/ai";
import { listToolsForIntegration, registerBuiltinTools } from "@alfred/api";
import { INTEGRATION_SLUGS } from "@alfred/contracts";

// Routed through the real dispatch helpers so the tool-name shim + provider
// options match prod. `getChatModel("standard")` = Haiku (the chat Auto tier),
// `getChatModel("deep")` = Opus + adaptive thinking (the Deep tier), and
// `getBossModel()` = Sonnet (the background boss) — all withFallback-wrapped
// (transparent on success). `thinking` carries the per-tier reasoning block so
// the Deep tier faithfully emits reasoning tokens BEFORE tool calls — the exact
// "5-7s thinking before tool calls" symptom this probe exists to isolate.
type ChatProviderOptions = ReturnType<typeof getChatProviderOptions>;
interface ProbeModel {
  model: LanguageModel;
  thinking?: ChatProviderOptions;
}
const MODELS: Record<string, () => ProbeModel> = {
  haiku: () => ({ model: getChatModel("standard"), thinking: getChatProviderOptions("standard") }),
  sonnet: () => ({ model: getBossModel() }),
  opus: () => ({ model: getChatModel("deep"), thinking: getChatProviderOptions("deep") }),
};
const SELECTED = (process.env.PROBE_MODELS ?? "haiku,sonnet,opus")
  .split(",")
  .map((s) => s.trim())
  .filter((m) => MODELS[m]);
const RUNS = Number(process.env.PROBE_RUNS ?? "3");
const MAX_OUT = Number(process.env.PROBE_MAX_OUT ?? "400");

/** The real prod ask — forces a multi-integration tool fan-out when tools exist. */
const USER_PROMPT = "enlist the activities across all of my integrations in the last 24 hours";

/**
 * A representative, stable boss-sized system block (cache-eligible). Content is
 * generic — what matters is that it's a constant ~few-KB prefix across all
 * conditions so the only thing varying is the tool set / model.
 */
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

/** Build the full real tool menu (system + every loadable integration). */
function buildAllTools(): { tools: ToolSet; count: number } {
  registerBuiltinTools(); // the registry is populated at server boot; do it here too.
  const out: Record<string, Tool> = {};
  for (const slug of INTEGRATION_SLUGS) {
    for (const r of listToolsForIntegration(slug)) {
      out[r.name] = tool({ description: r.description, inputSchema: r.inputSchema });
    }
  }
  return { tools: out as ToolSet, count: Object.keys(out).length };
}

interface Sample {
  ttftMs: number; // first content chunk of any kind
  firstTextMs: number | null; // first text-delta
  firstToolMs: number | null; // first tool-call / tool-input
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
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: USER_PROMPT }],
    ...(tools ? { tools } : {}),
    maxOutputTokens: MAX_OUT,
    temperature: 0,
    // Mirror prod: the per-tier reasoning block (Deep = Opus adaptive thinking)
    // plus the warm prompt cache on the stable system block.
    providerOptions: {
      ...thinking,
      anthropic: { ...thinking?.anthropic, cacheControl: { type: "ephemeral" } },
    },
  });

  for await (const part of res.fullStream) {
    const now = performance.now();
    const type = String((part as { type: string }).type);
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
  await once(model, tools, thinking).catch(() => null); // warm the prompt cache; ignore result
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
    const make = MODELS[m];
    if (!make) continue;
    const { model, thinking } = make();
    await condition(`${m} · no tools`, model, undefined, thinking);
    await condition(`${m} · ${count} tools (prod-like)`, model, tools, thinking);
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
