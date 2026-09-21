/**
 * Slice 0 probe for issue #1031: characterize the installed AI SDK's
 * provider-native tool-loading shapes end to end.
 *
 * The probe is opt-in and live: it spends a small amount of money against the
 * configured Cloudflare Unified Billing gateway. It makes no production change.
 *
 * Run from `packages/ai`:
 *
 *   ./node_modules/.bin/tsx --env-file=../../apps/server/.env \
 *     src/scripts/probe-native-tool-loading.ts --scenario=anthropic
 *
 * Scenarios: `anthropic`, `openai`, `fallback`, `all` (default). Each live
 * scenario makes two identical calls so a second-call cache read is observable.
 *
 * The probe records sanitized fixtures under
 * `packages/ai/test/fixtures/native-tool-loading/` for later slices' offline
 * tests. It never writes a provider credential: provider ids are stable-remapped
 * in both keys and values, response headers (account, organization, project,
 * gateway-trace, and bot-management identifiers) are dropped, and the gateway
 * token/account are redacted defensively before a fixture is written.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Middleware,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import {
  getStringPath,
  isRecord,
  redactSecrets,
  safeJsonParse,
  toJsonValue,
  toMessage,
  type JsonValue,
} from "@alfred/contracts";
import { cloudflareGatewayConfig } from "@alfred/env/server";
import {
  APICallError,
  generateText,
  isStepCount,
  streamText,
  tool,
  wrapLanguageModel,
  type ToolSet,
} from "ai";
import type { LanguageModel as LanguageModelV4 } from "ai-retry";
import { z } from "zod";

import { activeGateway } from "../gateway";
import type { ProviderId } from "../models";
import { anthropicLeg, googleLeg, openAiLeg } from "../provider-adapter";
import { attachProviderTurnPolicy } from "../request-projection";
import { withFallback } from "../provider";

// ── Configuration ──────────────────────────────────────────────────────────

const ANTHROPIC_MODEL_ID = "claude-sonnet-4-6";

const OPENAI_MODEL_ID = "gpt-5.6-luna";

const GEMINI_MODEL_ID = "gemini-3.8-flash";

const CACHE_TTL = "5m" as const;

const GENERATE_TIMEOUT_MS = 120_000;

const MAX_STEPS = 6;

const MAX_OUTPUT_TOKENS = 512;

const MAX_RETRIES = 3;

const EAGER_TOOL = "probe.eager";

const DISCOVERABLE_TOOLS = ["probe.alpha", "probe.beta"] as const;

/**
 * Reserved key for the provider-defined search tool. It must not contain a dot
 * or double underscore: the adapter's inner name shim decodes `__` to `.` on
 * every tool-call it sees, and the SDK derives the provider tool's low-level
 * `name` from this key. A dotted/underscored key would therefore come back
 * mangled and be rejected as an unknown tool.
 */
const NATIVE_SEARCH_KEY = "probeNativeSearch";

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/native-tool-loading",
);

// A stable, sizable context so the Anthropic system prefix clears the ~1024-token
// minimum cacheable size. Deterministic so repeated calls share a byte-identical
// prefix and a turn-2 read is meaningful.
const FILLER = Array.from(
  { length: 400 },
  (_, index) =>
    `Reference note ${index}: the quick brown fox jumps over the lazy dog near the riverbank.`,
).join(" ");

const SYSTEM_INSTRUCTIONS =
  "You are a tool-use test assistant. " +
  "You have a tool-search capability: when the tool you need is not directly available, " +
  "search for it and then call the tool the search returns. " +
  "When asked to record an observation, use the matching tool and then repeat its output verbatim. " +
  "Durable context you must keep in mind: " +
  FILLER;

/**
 * A per-process nonce in the system prefix keeps the first call cold. Without
 * it, a rerun within Anthropic's 5m TTL would read the previous run's cache and
 * the cold-write evidence would be ambiguous.
 */
const RUN_NONCE = randomUUID();

const PROBE_INSTRUCTIONS = `${SYSTEM_INSTRUCTIONS}\nRun nonce (ignore): ${RUN_NONCE}`;

const USER_PROMPT =
  "Find and call the tool that records a penguin sighting, with count 3. " +
  "Then reply with exactly the tool's output and nothing else.";

// ── SDK shape record (slice 0 item 1) ──────────────────────────────────────

/**
 * The installed-source shapes this probe is characterizing. These are the
 * documented low-level projections the provider packages own; the live capture
 * below proves the normalized parts and request serialization match.
 */
const INSTALLED_SDK_CONTRACTS = {
  anthropic: {
    searchToolConstructor: "anthropic.tools.toolSearchBm25_20251119()",
    searchToolLowLevel: {
      type: "provider",
      id: "anthropic.tool_search_bm25_20251119",
      name: "tool_search_tool_bm25",
    },
    deferralFlag: "providerOptions.anthropic.deferLoading -> wire defer_loading",
    normalizedSearchCall:
      'tool-call { toolName: <reserved ToolSet key>, providerExecuted: true, input: JSON.stringify({query,limit?}) } (wire server_tool_use.name = "tool_search_tool_bm25")',
    normalizedSearchResult:
      'tool-result { toolName: <reserved ToolSet key>, output: [{ type: "tool_reference", toolName: <encoded function name> }] } (wire tool_search_tool_result)',
  },
  openai: {
    searchToolConstructor: 'openai.tools.toolSearch({ execution: "server" })',
    searchToolLowLevel: { type: "provider", id: "openai.tool_search", name: "tool_search" },
    deferralFlag: "providerOptions.openai.deferLoading -> wire defer_loading",
    normalizedSearchCall:
      "tool-call { toolName: <reserved ToolSet key>, providerExecuted: true (server execution), input: JSON.stringify({arguments, call_id}) } (wire tool_search_call)",
    normalizedSearchResult:
      "tool-result { toolName: <reserved ToolSet key>, output: { tools: JSONObject[] } } (wire tool_search_output; server execution only sets providerExecuted)",
  },
} as const;

const NOTES = {
  anthropicNative: [
    "Native discovery evidence is the provider search RESULT block, not the final call name.",
    "The normalized search tool-call's toolName is the caller's reserved ToolSet key (probeNativeSearch), not the wire server_tool_use.name.",
    "The adapter's name shim decodes `__` to `.` on every tool-call it sees, so the reserved search key must avoid `__` and `.` or it comes back mangled and is rejected as unknown.",
    "Normalized search result: tool-result whose output is [{ type: 'tool_reference', toolName }]; toolName values stay adapter-encoded (probe__alpha).",
    "Final client call: a normal tool-call whose toolName the adapter decodes back to probe.alpha.",
    "Raw response body carries the native server_tool_use / tool_search_tool_result / tool_use blocks.",
    "Wire body: defer_loading only on the two discoverable function tools; cache_control only on the system block and the last eager function tool.",
  ],
  openaiNative: [
    "Native discovery evidence is the tool_search_output result's tools array.",
    "The normalized search tool-call's toolName is the caller's reserved ToolSet key, not the wire tool_search_call name.",
    "Server-executed search: providerExecuted is true on the search tool-call; client execution would leave it false.",
    "The final function_call carries namespace metadata equal to the encoded tool name; the adapter decodes the normalized toolName back to probe.alpha.",
  ],
  fallback: [
    "The probe middleware runs outside the projection, so the captured primary params carry Alfred's internal request-envelope namespace; the fixture strips it and records primaryTransformedParamsCarriedEnvelope. The wire bodies are the authority for envelope absence. internalEnvelopeAbsent covers the dispatched Google wire body; the primary was never dispatched (it fails synthetically before the provider call).",
    "The live Google wire body lists only probe__eager under functionDeclarations and no provider tool: the per-leg application projection held.",
    "Application mode declares only probe__eager and no provider tool. Because the probe system prompt still advertises native tool search, the fallback could not discover the penguin tool: it emitted calls to names it was never given (see the captured steps) and never completed the task. Application mode must not advertise native discovery.",
  ],
} as const;

// ── Tools ──────────────────────────────────────────────────────────────────

function buildFunctionTools(): ToolSet {
  return {
    [EAGER_TOOL]: tool({
      description: "Record the current weather for a city.",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => `weather:${city}:sunny`,
    }),
    "probe.alpha": tool({
      description: "Record a penguin sighting. Use for penguin observations.",
      inputSchema: z.object({ count: z.number() }),
      execute: async ({ count }) => `recorded ${count} penguins`,
    }),
    "probe.beta": tool({
      description: "Record a whale sighting. Use for whale observations.",
      inputSchema: z.object({ count: z.number() }),
      execute: async ({ count }) => `recorded ${count} whales`,
    }),
  };
}

function withNativeSearchTool(tools: ToolSet, provider: ProviderId): ToolSet {
  if (provider === "anthropic") {
    // SAFETY: the SDK unifies provider-defined tools' input generic to `never`
    // inside the non-generic `ToolSet`; this record is one provider tool under
    // its own reserved key, which is exactly the ToolSet shape.
    return {
      ...tools,
      [NATIVE_SEARCH_KEY]: anthropic.tools.toolSearchBm25_20251119(),
    } as ToolSet;
  }

  if (provider === "openai") {
    // SAFETY: same provider-defined-tool `never`-input widening as above.
    return {
      ...tools,
      [NATIVE_SEARCH_KEY]: openai.tools.toolSearch({ execution: "server" }),
    } as ToolSet;
  }

  return tools;
}

// ── Probe protocol middleware ──────────────────────────────────────────────

type ToolDefinition = NonNullable<LanguageModelV4CallOptions["tools"]>[number];

type FunctionToolDefinition = Extract<ToolDefinition, { type: "function" }>;

const DISCOVERABLE = new Set<string>(DISCOVERABLE_TOOLS);

function withDeferLoading(
  toolDefinition: FunctionToolDefinition,
  provider: ProviderId,
): FunctionToolDefinition {
  const existing = toolDefinition.providerOptions;
  const bag = existing?.[provider] ?? {};

  const providerOptions: SharedV4ProviderOptions = {
    ...existing,
    [provider]: { ...bag, deferLoading: true },
  };

  return { ...toolDefinition, providerOptions };
}

function withAnthropicCacheControl<
  T extends { readonly providerOptions?: SharedV4ProviderOptions },
>(value: T): T {
  const existing = value.providerOptions;
  const anthropicBag = existing?.anthropic ?? {};

  return {
    ...value,
    providerOptions: {
      ...existing,
      anthropic: { ...anthropicBag, cacheControl: { type: "ephemeral", ttl: CACHE_TTL } },
    },
  };
}

function decorateAnthropicPrompt(
  prompt: LanguageModelV4CallOptions["prompt"],
  tools: readonly ToolDefinition[],
) {
  const decoratedPrompt = prompt.slice();

  if (decoratedPrompt[0]?.role === "system") {
    decoratedPrompt[0] = withAnthropicCacheControl(decoratedPrompt[0]);
  }

  const decoratedTools = tools.slice();
  let lastEagerIndex = -1;

  for (let index = decoratedTools.length - 1; index >= 0; index--) {
    const definition = decoratedTools[index];

    if (definition?.type === "function" && definition.name === EAGER_TOOL) {
      lastEagerIndex = index;

      break;
    }
  }

  if (lastEagerIndex !== -1) {
    const eager = decoratedTools[lastEagerIndex];

    if (eager?.type === "function")
      decoratedTools[lastEagerIndex] = withAnthropicCacheControl(eager);
  }

  return { prompt: decoratedPrompt, tools: decoratedTools };
}

interface ProbeProtocol {
  readonly provider: ProviderId;
  readonly mode: "native" | "application";
}

function transformSurface(
  params: LanguageModelV4CallOptions,
  protocol: ProbeProtocol,
): LanguageModelV4CallOptions {
  const tools = params.tools ?? [];

  if (protocol.mode === "application") {
    // Application mode sees only the eager kernel: every provider-defined
    // search tool and every discoverable function tool is dropped.
    const eagerTools = tools.filter(
      (definition) => definition.type === "function" && !DISCOVERABLE.has(definition.name),
    );

    return { ...params, tools: eagerTools };
  }

  const withDeferral = tools.map((definition) =>
    definition.type === "function" && DISCOVERABLE.has(definition.name)
      ? withDeferLoading(definition, protocol.provider)
      : definition,
  );

  if (protocol.provider === "anthropic") {
    const decorated = decorateAnthropicPrompt(params.prompt, withDeferral);

    return { ...params, tools: [...decorated.tools], prompt: decorated.prompt };
  }

  return { ...params, tools: withDeferral };
}

function probeMiddleware(protocol: ProbeProtocol): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => transformSurface(params, protocol),
  };
}

// ── Leg construction ───────────────────────────────────────────────────────

function probeLeg(provider: ProviderId, model: LanguageModelV4, mode: "native" | "application") {
  return wrapLanguageModel({
    model,
    middleware: probeMiddleware({ provider, mode }),
  });
}

// ── Capture and sanitization ───────────────────────────────────────────────

/**
 * Provider ids appear as both values and object keys (for example
 * `performance.toolExecutionMs` is keyed by the raw tool-call id). The prefix
 * set covers Anthropic (`toolu`, `srvtoolu`, `msg`), OpenAI (`call`, `tsc`,
 * `tso`, `rs`, `resp`), Google (`call`), and chat-completions shapes.
 *
 * Values can be short (Google mints `call_5393`), so the value pattern has no
 * length floor. Keys do: a field name such as `call_id` must not be renamed,
 * so a key only counts as an id when it carries the long, high-entropy tail a
 * real provider id has.
 */
const ID_VALUE =
  /^(?:msg|resp|toolu|srvtoolu|call|tsc|tso|req|chatcmpl|fc|item|evt|rs)_[A-Za-z0-9_-]+$/;

const RAW_PROVIDER_ID_KEY =
  /^(?:msg|resp|toolu|srvtoolu|call|tsc|tso|req|chatcmpl|fc|item|evt|rs)_[A-Za-z0-9_-]{12,}$/;

const SECRET_KEYS = new Set([
  "authorization",
  "api_key",
  "apikey",
  "cf-aig-authorization",
  "x-api-key",
  "openai_api_key",
]);

/**
 * Response metadata that is never part of the tool-loading shape but carries
 * account, organization, project, gateway-trace, or bot-management identifiers.
 * Dropping the whole block beats enumerating every provider-specific header.
 */
const DROPPED_KEYS = new Set(["headers", "set-cookie"]);

function stableId(raw: string, ids: Map<string, string>): string {
  const existing = ids.get(raw);

  if (existing) return existing;

  const minted = `id_${ids.size + 1}`;

  ids.set(raw, minted);

  return minted;
}

function sanitizeJson(value: JsonValue, ids: Map<string, string>): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => sanitizeJson(entry, ids));

  if (isRecord(value)) {
    const out: Record<string, JsonValue> = {};

    for (const [key, entry] of Object.entries(value)) {
      const lower = key.toLowerCase();

      if (SECRET_KEYS.has(lower) || DROPPED_KEYS.has(lower)) continue;

      const outKey = RAW_PROVIDER_ID_KEY.test(key) ? stableId(key, ids) : key;

      if (typeof entry === "string" && ID_VALUE.test(entry)) {
        out[outKey] = stableId(entry, ids);

        continue;
      }

      out[outKey] = sanitizeJson(entry, ids);
    }

    return out;
  }

  return value;
}

/**
 * Replace the configured gateway token/account with markers. The canonical
 * `redactSecrets` runs on top of this in `writeFixture` as a second pass.
 */
function redactGatewayConfig(text: string): string {
  const config = cloudflareGatewayConfig();

  if (!config) return text;

  return text
    .replaceAll(config.token, "[redacted-token]")
    .replaceAll(config.accountId, "[redacted-account]");
}

// ── SDK versions ───────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);

function packageVersion(specifier: string): string {
  const entry = require.resolve(specifier);
  let dir = dirname(entry);

  while (dir !== dirname(dir)) {
    const packageJson = join(dir, "package.json");

    if (existsSync(packageJson)) {
      const parsed = safeJsonParse(readFileSync(packageJson, "utf8"));
      const name = getStringPath(parsed, "name");
      const version = getStringPath(parsed, "version");

      if (name === specifier && version) return version;
    }

    dir = dirname(dir);
  }

  return "unknown";
}

function sdkVersions() {
  return {
    ai: packageVersion("ai"),
    "@ai-sdk/anthropic": packageVersion("@ai-sdk/anthropic"),
    "@ai-sdk/openai": packageVersion("@ai-sdk/openai"),
    "@ai-sdk/google": packageVersion("@ai-sdk/google"),
    "@ai-sdk/provider": packageVersion("@ai-sdk/provider"),
    "ai-retry": packageVersion("ai-retry"),
  };
}

// ── Scenario runner ─────────────────────────────────────────────────────────

interface StepRecord {
  index: number;
  finishReason: string;
  requestBody: JsonValue;
  responseBody: JsonValue;
  content: JsonValue;
  usage: JsonValue;
  providerMetadata: JsonValue;
}

interface RunRecord {
  steps: StepRecord[];
  responseMessages: JsonValue;
  usage: JsonValue;
}

interface StreamRecord {
  parts: JsonValue;
  responseBody: JsonValue;
  responseMessages: JsonValue;
}

interface FallbackRecord {
  /** The native-transformed primary params the probe middleware produced before the projection threw. */
  primaryTransformedParams: JsonValue;
  /** The live Google wire request body: the per-leg application projection's output. */
  fallbackRequestBody: JsonValue;
}

interface ScenarioResult {
  scenario: string;
  model: { provider: ProviderId; modelId: string };
  sdk: Record<string, string>;
  installedSdkContracts: unknown;
  notes: string[];
  runs: RunRecord[];
  streams: StreamRecord[];
  fallback?: FallbackRecord;
  checks: Record<string, unknown>;
}

type ProbeResult = Awaited<ReturnType<typeof generateText>>;

function captureRun(result: ProbeResult, ids: Map<string, string>): RunRecord {
  return {
    steps: result.steps.map((step, index) => ({
      index,
      finishReason: String(step.finishReason),
      requestBody: sanitizeJson(toJsonValue(step.request.body), ids),
      responseBody: sanitizeJson(toJsonValue(step.response.body), ids),
      content: sanitizeJson(toJsonValue(step.content), ids),
      usage: sanitizeJson(toJsonValue(step.usage), ids),
      providerMetadata: sanitizeJson(toJsonValue(step.providerMetadata), ids),
    })),
    responseMessages: sanitizeJson(toJsonValue(result.responseMessages), ids),
    usage: sanitizeJson(toJsonValue(result.usage), ids),
  };
}

function generateOptions(model: LanguageModelV4, tools: ToolSet) {
  return {
    model,
    instructions: PROBE_INSTRUCTIONS,
    messages: [{ role: "user" as const, content: USER_PROMPT }],
    tools,
    providerOptions: attachProviderTurnPolicy(undefined, undefined),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeout: GENERATE_TIMEOUT_MS,
    stopWhen: isStepCount(MAX_STEPS),
    maxRetries: MAX_RETRIES,
    include: { requestBody: true, responseBody: true },
  };
}

async function captureStream(
  model: LanguageModelV4,
  tools: ToolSet,
  ids: Map<string, string>,
): Promise<StreamRecord> {
  const stream = streamText(generateOptions(model, tools));
  const parts: JsonValue[] = [];

  for await (const part of stream.fullStream) {
    parts.push(sanitizeJson(toJsonValue(part), ids));
  }

  const response = await stream.response;
  const responseMessages = await stream.responseMessages;

  return {
    parts,
    responseBody: sanitizeJson(toJsonValue(response.body), ids),
    responseMessages: sanitizeJson(toJsonValue(responseMessages), ids),
  };
}

async function runNativeScenario(options: {
  scenario: string;
  provider: ProviderId;
  modelId: string;
  tools: ToolSet;
  leg: LanguageModelV4;
  runs: number;
  notes: string[];
}): Promise<ScenarioResult> {
  const ids = new Map<string, string>();
  const runs: RunRecord[] = [];

  for (let index = 0; index < options.runs; index++) {
    const result = await generateText(generateOptions(options.leg, options.tools));

    runs.push(captureRun(result, ids));
  }

  const streams: StreamRecord[] = [await captureStream(options.leg, options.tools, ids)];

  return {
    scenario: options.scenario,
    model: { provider: options.provider, modelId: options.modelId },
    sdk: sdkVersions(),
    installedSdkContracts: INSTALLED_SDK_CONTRACTS,
    notes: options.notes,
    runs,
    streams,
    checks: { ...inspectRuns(runs), ...inspectStreams(streams) },
  };
}

// ── Evidence extraction ─────────────────────────────────────────────────────

function collectByType(value: JsonValue, type: string, out: JsonValue[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectByType(entry, type, out);

    return;
  }

  if (!isRecord(value)) return;

  if (value.type === type) out.push(value);

  for (const entry of Object.values(value)) collectByType(entry, type, out);
}

function collectToolReferences(value: JsonValue, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectToolReferences(entry, out);

    return;
  }

  if (!isRecord(value)) return;

  if (value.type === "tool_reference" && typeof value.toolName === "string") {
    out.add(value.toolName);
  }

  // OpenAI's `tool_search_output` carries discovered definitions as `tools`.
  if (Array.isArray(value.tools)) {
    for (const tool of value.tools) {
      if (isRecord(tool) && typeof tool.name === "string") out.add(tool.name);
    }
  }

  for (const entry of Object.values(value)) collectToolReferences(entry, out);
}

function inspectRuns(runs: readonly RunRecord[]) {
  const toolCalls: JsonValue[] = [];
  const toolResults: JsonValue[] = [];
  const providerBodies: JsonValue[] = [];

  for (const run of runs) {
    for (const step of run.steps) {
      collectByType(step.content, "tool-call", toolCalls);
      collectByType(step.content, "tool-result", toolResults);
      providerBodies.push(step.requestBody, step.responseBody);
    }
  }

  const providerSearchCalls: string[] = [];
  const clientToolCallNames: string[] = [];

  for (const call of toolCalls) {
    if (!isRecord(call)) continue;

    if (call.providerExecuted === true) {
      if (typeof call.toolName === "string") providerSearchCalls.push(call.toolName);
    } else if (typeof call.toolName === "string") {
      clientToolCallNames.push(call.toolName);
    }
  }

  const discoveredToolNames = new Set<string>();

  for (const result of toolResults) collectToolReferences(result, discoveredToolNames);

  const cacheReadTokens: number[] = [];

  for (const run of runs) {
    for (const step of run.steps) {
      if (!isRecord(step.usage)) continue;
      const details = step.usage.inputTokenDetails;

      if (isRecord(details) && typeof details.cacheReadTokens === "number") {
        cacheReadTokens.push(details.cacheReadTokens);
      }
    }
  }

  return {
    internalEnvelopeAbsent: !JSON.stringify(providerBodies).includes("alfredInternal"),
    providerSearchCalls,
    discoveredToolNames: [...discoveredToolNames].sort(),
    clientToolCallNames,
    cacheReadTokens,
  };
}

function inspectStreams(streams: readonly StreamRecord[]) {
  const partTypes = new Set<string>();
  const toolCalls: JsonValue[] = [];
  const toolResults: JsonValue[] = [];
  const providerBodies: JsonValue[] = [];

  for (const stream of streams) {
    if (Array.isArray(stream.parts)) {
      for (const part of stream.parts) {
        if (isRecord(part) && typeof part.type === "string") partTypes.add(part.type);
      }
    }

    collectByType(stream.parts, "tool-call", toolCalls);
    collectByType(stream.parts, "tool-result", toolResults);
    providerBodies.push(stream.responseBody, stream.responseMessages);
  }

  const discoveredToolNames = new Set<string>();

  for (const result of toolResults) collectToolReferences(result, discoveredToolNames);

  return {
    streamPartTypes: [...partTypes].sort(),
    streamInternalEnvelopeAbsent: !JSON.stringify(providerBodies).includes("alfredInternal"),
    streamDiscoveredToolNames: [...discoveredToolNames].sort(),
  };
}

// ── Entrypoint ──────────────────────────────────────────────────────────────

type ScenarioName = "anthropic" | "openai" | "fallback" | "all";

function selectedScenario(): ScenarioName {
  const arg = process.argv.find((value) => value.startsWith("--scenario="));

  if (!arg) return "all";
  const value = arg.slice("--scenario=".length);

  if (value === "anthropic" || value === "openai" || value === "fallback" || value === "all") {
    return value;
  }

  throw new Error(`unknown --scenario=${value}`);
}

async function runAnthropic(): Promise<ScenarioResult> {
  const tools = withNativeSearchTool(buildFunctionTools(), "anthropic");
  const leg = probeLeg("anthropic", anthropicLeg(ANTHROPIC_MODEL_ID).model, "native");

  return await runNativeScenario({
    scenario: "anthropic-native",
    provider: "anthropic",
    modelId: ANTHROPIC_MODEL_ID,
    tools,
    leg,
    runs: 2,
    notes: [...NOTES.anthropicNative],
  });
}

async function runOpenAi(): Promise<ScenarioResult> {
  const tools = withNativeSearchTool(buildFunctionTools(), "openai");
  const leg = probeLeg("openai", openAiLeg(OPENAI_MODEL_ID).model, "native");

  return await runNativeScenario({
    scenario: "openai-native",
    provider: "openai",
    modelId: OPENAI_MODEL_ID,
    tools,
    leg,
    runs: 2,
    notes: [...NOTES.openaiNative],
  });
}

/**
 * A synthetic retryable failure that fires before the primary provider is
 * dispatched, so the Anthropic->Gemini fallback is exercised without a second
 * billable Anthropic call. The middleware still runs the native projection
 * first, so the captured primary params prove what the primary *would* have
 * sent while the live Google leg proves the application projection.
 */
function forcingPrimaryFailureMiddleware(
  capture: LanguageModelV4CallOptions[],
): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => {
      const transformed = transformSurface(params, { provider: "anthropic", mode: "native" });

      capture.push(transformed);

      return transformed;
    },
    wrapGenerate: async () => {
      throw new APICallError({
        message:
          "synthetic primary failure (probe): forced fallback to characterize per-leg projection",
        url: "https://probe.invalid/v1",
        requestBodyValues: {},
        statusCode: 500,
        isRetryable: false,
      });
    },
  };
}

async function runFallback(): Promise<ScenarioResult> {
  const ids = new Map<string, string>();
  const tools = withNativeSearchTool(buildFunctionTools(), "anthropic");
  const capturedPrimary: LanguageModelV4CallOptions[] = [];

  const primary = wrapLanguageModel({
    model: anthropicLeg(ANTHROPIC_MODEL_ID).model,
    middleware: forcingPrimaryFailureMiddleware(capturedPrimary),
  });

  const fallback = probeLeg("google", googleLeg(GEMINI_MODEL_ID).model, "application");
  const model = withFallback(primary, fallback);

  const result = await generateText(generateOptions(model, tools));
  const run = captureRun(result, ids);
  const fallbackRequestBody = sanitizeJson(toJsonValue(result.finalStep.request.body), ids);
  const rawPrimaryParams = sanitizeJson(toJsonValue(capturedPrimary[0]), ids);
  const primaryCarriedEnvelope = JSON.stringify(rawPrimaryParams).includes("alfredInternal");
  // The captured primary params are pre-projection, so they still hold the
  // internal envelope. Strip it from the fixture so no committed file contains
  // it; the boolean records that the probe middleware ran outside the projection.
  const primaryTransformedParams = stripInternalEnvelope(rawPrimaryParams);
  const fallbackTools = extractWireToolNames(fallbackRequestBody);

  return {
    scenario: "anthropic-to-gemini-fallback",
    model: { provider: "anthropic", modelId: `${ANTHROPIC_MODEL_ID} -> ${GEMINI_MODEL_ID}` },
    sdk: sdkVersions(),
    installedSdkContracts: INSTALLED_SDK_CONTRACTS,
    notes: [...NOTES.fallback],
    runs: [run],
    streams: [],
    fallback: { primaryTransformedParams, fallbackRequestBody },
    checks: {
      ...inspectRuns([run]),
      primaryTransformedParamsCarriedEnvelope: primaryCarriedEnvelope,
      primaryHasProviderSearchTool: JSON.stringify(primaryTransformedParams).includes(
        "anthropic.tool_search_bm25_20251119",
      ),
      primaryHasDeferredFlag:
        JSON.stringify(primaryTransformedParams).includes('"deferLoading":true'),
      fallbackWireToolNames: fallbackTools,
      fallbackOnlyEagerTool:
        fallbackTools.functions.length === 1 && fallbackTools.functions[0] === "probe__eager",
      fallbackHasNoProviderTool: fallbackTools.providerTools.length === 0,
    },
  };
}

function stripInternalEnvelope(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => stripInternalEnvelope(entry));

  if (isRecord(value)) {
    const out: Record<string, JsonValue> = {};

    for (const [key, entry] of Object.entries(value)) {
      if (key === "alfredInternal") continue;

      out[key] = stripInternalEnvelope(entry);
    }

    return out;
  }

  return value;
}

function extractWireToolNames(requestBody: JsonValue) {
  if (!isRecord(requestBody) || !Array.isArray(requestBody.tools)) {
    return { functions: [], providerTools: [] };
  }

  const functions: string[] = [];
  const providerTools: string[] = [];

  for (const toolDefinition of requestBody.tools) {
    if (!isRecord(toolDefinition)) continue;

    // Google's AI-Studio body groups functions under `functionDeclarations`.
    if (Array.isArray(toolDefinition.functionDeclarations)) {
      for (const declaration of toolDefinition.functionDeclarations) {
        if (isRecord(declaration) && typeof declaration.name === "string") {
          functions.push(declaration.name);
        }
      }

      continue;
    }

    // Anthropic/OpenAI provider-defined tools carry a non-"function" `type`.
    if (typeof toolDefinition.type === "string" && toolDefinition.type !== "function") {
      providerTools.push(toolDefinition.type);

      continue;
    }

    // OpenAI Responses function tools nest under `function`; Anthropic and
    // OpenAI Chat functions carry `name` at the top level.
    if (isRecord(toolDefinition.function) && typeof toolDefinition.function.name === "string") {
      functions.push(toolDefinition.function.name);

      continue;
    }

    if (typeof toolDefinition.name === "string") functions.push(toolDefinition.name);
  }

  return { functions, providerTools };
}

function writeFixture(result: ScenarioResult): string {
  const body = redactSecrets(redactGatewayConfig(JSON.stringify(result, null, 2)));

  mkdirSync(FIXTURE_DIR, { recursive: true });
  const path = join(FIXTURE_DIR, `${result.scenario}.json`);

  writeFileSync(path, `${body}\n`, "utf8");

  return path;
}

async function main(): Promise<void> {
  const gateway = activeGateway();

  if (gateway.kind !== "cloudflare") {
    throw new Error(
      "probe requires the Cloudflare gateway (CLOUDFLARE_AI_GATEWAY_TOKEN + CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_GATEWAY_ID)",
    );
  }

  const scenario = selectedScenario();
  const scenarios: Array<() => Promise<ScenarioResult>> = [];

  if (scenario === "anthropic" || scenario === "all") scenarios.push(runAnthropic);

  if (scenario === "openai" || scenario === "all") scenarios.push(runOpenAi);

  if (scenario === "fallback" || scenario === "all") scenarios.push(runFallback);

  const failures: unknown[] = [];

  for (const runOne of scenarios) {
    try {
      const result = await runOne();
      const path = writeFixture(result);

      console.log(`[native-tool-probe] wrote ${path}`);
      console.log(`  ${JSON.stringify(result.checks)}`);
    } catch (error: unknown) {
      // Keep going so a rate limit on one provider does not discard the
      // fixtures the other scenarios already captured.
      failures.push(error);
      console.error("[native-tool-probe] scenario failed:", toMessage(error));
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} scenario(s) failed; rerun them individually`);
  }
}

main().catch((error: unknown) => {
  console.error("[native-tool-probe] FAIL:", toMessage(error));
  process.exitCode = 1;
});
