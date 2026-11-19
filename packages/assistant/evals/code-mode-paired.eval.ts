import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CODE_MODE_READ_PATH_FEATURE_KEY, keyGuard, toMessage } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { closeRedis } from "@alfred/db/redis";
import {
  actionStagings,
  agentRuns,
  apiCallLog,
  chatMessages,
  chatThreads,
  user,
  userActionPolicies,
} from "@alfred/db/schemas";
import {
  anthropicLeg,
  flushMeteringWrites,
  probeRoute,
  route,
  routeEffort,
  type ModelRouteHandle,
} from "@alfred/ai";
import { _setRouteOverrideForTests, openAiLeg } from "@alfred/ai/test-support";
import { serverEnv } from "@alfred/env/server";
import { and, eq, inArray } from "drizzle-orm";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { ensureDefaultActionPolicyForUser } from "@alfred/assistant/action-policies";
import { chatTurnWorkflow } from "@alfred/assistant/chat";
import { registerDefaultContextSources } from "@alfred/assistant/context-search";
import { registerRecipe } from "@alfred/assistant/execution";
import { settings } from "@alfred/assistant/settings";
import { permissiveMcpEndpointAuthorizerForTests } from "@alfred/assistant/connections/mcp/test-support";
import {
  _setMcpExecutionBrokerForTests,
  upsertToolPolicy,
} from "@alfred/assistant/tool-runtime/mcp/test-support";
import { startChatTurn } from "../src/chat/turn-admission";
import { McpRawClient } from "../src/connections/mcp/client";
import { GITHUB_MCP_ENDPOINT_HREF } from "../src/connections/mcp/constants";
import { descriptorHash } from "../src/connections/mcp/hash";
import { McpConnectionManager } from "../src/connections/mcp/manager";
import { ensureConnection } from "../src/connections/mcp/persistence";
import {
  _setMcpConnectionManagerForTests,
  getMcpConnectionManager,
} from "../src/connections/mcp/runtime";
import { runOnce } from "../src/execution/executor";
import {
  _setRuntimeSpanStarterForTests,
  RUNTIME_TOOL_SURFACE,
} from "../src/execution/runtime-spans";
import { stagedAction } from "../src/execution/staged-action";
import { registerRuntimeAdapters } from "../src/runtime/adapters/runtime-adapters";
import { registerBuiltinTools } from "../src/tool-runtime/builtin-tools";
import { registerDispatchToolCallRoundAdapter } from "../src/tool-runtime/internal/dispatch/pipeline";
import { McpExecutionBroker } from "../src/tool-runtime/mcp/broker";
import {
  CRASH_LOG_FACT,
  CRASH_LOG_ISSUE,
  FakeGithubProtocol,
  GITHUB_CATALOG,
  LAST_COMMENT_FACT,
  MOST_DISCUSSED_ISSUE,
  OPEN_ISSUE_ROOT_CAUSES,
  OPEN_ISSUES,
  REPO_NAME,
  REPO_OWNER,
  SETUP_FILE_FACTS,
  SETUP_FILE_PATH,
} from "./lib/github-repo-fixture";

// The paired evaluation of ADR-0124 ("The default stays an experiment"), as settled in
// docs/plans/code-mode-object-handles-v1.md, "The paired evaluation". Each case runs in both
// read modes, three times each, through the production chat loop: `startChatTurn`, then
// `runOnce` in this process until the run stops. The prompt, the pinned read path, the tool
// surface, dispatch, staging, and the approval park are production code. Only the GitHub MCP
// server is fake, at its protocol client, behind the real GitHub read-only endpoint.
//
// Needs the local Postgres and Redis and the model keys in apps/server/.env. Stop the dev server
// first: its worker leases the same runs, and it has no fake GitHub server.
// Run: `pnpm --filter @alfred/assistant exec evalite run code-mode-paired`. A filtered run
// (`CODE_MODE_PAIRED_ONLY`, below) runs once, so its report is not a verdict.
// The verdict of the owner's rule goes to references/scratch/code-mode-paired/ (gitignored).
// `CODE_MODE_PAIRED_MODEL` (below) puts every chat route on another model for the whole run.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

const REPEATS = 3;

/** A whole turn, with every step and every card. The chat turn ceiling is 180 s for one step. */
const RUN_DEADLINE_MS = 9 * 60_000;

/** A single lookup may cost at most this much more in Code Mode (owner rule, 2026-11-18). */
const SINGLE_LOOKUP_TOLERANCE = 1.2;

const REPORT_DIR = path.resolve(
  import.meta.dirname,
  "../../../references/scratch/code-mode-paired",
);

/** The owner's production rules for this integration (local policy row, 2026-11-18). */
const OWNER_INTEGRATION_RULES = {
  system: { mode: "autonomy" },
  github: { mode: "autonomy" },
} as const;

/**
 * The chat model for the whole run. The verdict compares the two modes on one model, so a
 * cross-model comparison reads the cost column of two reports, not their tokens.
 */
const PAIRED_MODELS = {
  // The product chat route, with no override.
  luna: null,
  // The chat route's own reasoning level.
  haiku: () => probeRoute(anthropicLeg("claude-haiku-5-5"), routeEffort("standard")),
  // `gpt-6.2-sol` gets a 401 from the gateway (2026-11-18), so the eval uses 6.1 at the same price.
  sol61: () => probeRoute(openAiLeg("gpt-6.1-sol"), "medium"),
} as const satisfies Record<string, (() => ModelRouteHandle) | null>;

type PairedModel = keyof typeof PAIRED_MODELS;

const isPairedModel = keyGuard(PAIRED_MODELS);

function pairedModel(): PairedModel {
  const value = process.env.CODE_MODE_PAIRED_MODEL ?? "luna";

  if (!isPairedModel(value)) {
    throw new Error(
      `CODE_MODE_PAIRED_MODEL=${value} is not one of ${Object.keys(PAIRED_MODELS).join(", ")}`,
    );
  }

  return value;
}

const PAIRED_MODEL = pairedModel();

type Mode = "direct" | "code_mode";

const MODES: readonly Mode[] = ["direct", "code_mode"];

type CaseKind =
  | "single_lookup"
  | "large_single_result"
  | "fan_out"
  | "dependent_reads"
  | "gated_read";

interface Case {
  kind: CaseKind;
  prompt: string;
  /** The planted facts that the answer must state. */
  facts: readonly string[];
  /** An owner review puts `get_file_contents` on the `high` tier, so the read waits for a card. */
  gated?: true;
}

const REPO = `${REPO_OWNER}/${REPO_NAME}`;

const SINGLE_LOOKUP_ISSUE = OPEN_ISSUES[7] ?? OPEN_ISSUES[0];

const CASES: readonly Case[] = [
  {
    kind: "single_lookup",
    prompt: `In the GitHub repo ${REPO}, what is the root cause of issue #${SINGLE_LOOKUP_ISSUE?.number}?`,
    facts: [OPEN_ISSUE_ROOT_CAUSES[7] ?? ""],
  },
  {
    kind: "large_single_result",
    prompt: `Issue #${CRASH_LOG_ISSUE.number} in the GitHub repo ${REPO} holds a long crash log. Which function threw first, according to the log?`,
    facts: [CRASH_LOG_FACT],
  },
  {
    // The driver run `run_s7yi1ymxakcj` (2026-11-08), with the repo named and the root cause asked.
    kind: "fan_out",
    prompt: `what are the open issues in the GitHub repo ${REPO}? give me the gist of each one, with its root cause`,
    facts: OPEN_ISSUE_ROOT_CAUSES,
  },
  {
    kind: "dependent_reads",
    prompt: `Which open issue in the GitHub repo ${REPO} has the most comments? What does its last comment say?`,
    facts: [String(MOST_DISCUSSED_ISSUE?.number), LAST_COMMENT_FACT],
  },
  {
    kind: "gated_read",
    prompt: `Read ${SETUP_FILE_PATH} in the GitHub repo ${REPO}. Which Node version does it need, and what is the local setup key?`,
    facts: SETUP_FILE_FACTS,
    gated: true,
  },
];

interface RunInput {
  kind: CaseKind;
  mode: Mode;
  repeat: number;
}

interface RunMeasure extends RunInput {
  /** The primary model id of the chat route for this run. */
  model: string;
  /** The model ids that `api_call_log` recorded for the run's chat steps. */
  servedModels: string[];
  error: string | null;
  /** The share of planted facts that the answer states. */
  quality: number;
  latencyMs: number;
  totalTokens: number;
  /** The sum of `api_call_log.cost_usd` for the run. Tokenizers differ, so this compares models. */
  costUsd: number;
  /** The largest input of one model call in the run. */
  maxInputTokens: number;
  modelSteps: number;
  approvalCards: number;
  firstStepSchemaTokens: number | null;
  toolCalls: string[];
  /** Each tool call with its status and the start of its result, so a failed case shows why. */
  toolTrail: string[];
  remoteCalls: string[];
  answer: string;
}

let booted = false;

/** The chat route's primary model id, known after `boot`. */
let chatModelId = "";

/** The tool-surface spans of each run, in order. The eval keeps no other span. */
const surfaceTokens = new Map<string, number[]>();

/** Register what `apps/server/src/runtime.ts` registers, without the workers or the HTTP app. */
function boot(): void {
  if (booted) return;
  booted = true;
  serverEnv();
  registerRecipe(chatTurnWorkflow);
  registerBuiltinTools();
  registerDefaultContextSources();
  registerDispatchToolCallRoundAdapter();
  registerRuntimeAdapters();
  const override = PAIRED_MODELS[PAIRED_MODEL];

  // The process ends with the run, so the override is never restored.
  if (override) _setRouteOverrideForTests("chat", override());
  chatModelId = route("standard").model().modelId;
  _setRuntimeSpanStarterForTests((input) => ({
    end(args) {
      if (input.name !== RUNTIME_TOOL_SURFACE) return;
      const tokens = args.metadata?.schemaTokens;

      if (typeof tokens !== "number") return;
      surfaceTokens.set(input.runId, [...(surfaceTokens.get(input.runId) ?? []), tokens]);
    },
  }));
}

/** One fake GitHub server for each run, so each run sees only its own calls. */
function installGithub(): FakeGithubProtocol {
  const protocol = new FakeGithubProtocol();

  const manager = new McpConnectionManager({
    clientFactory: (owned) =>
      new McpRawClient({
        auth: { mode: "none" },
        connectionId: owned.id,
        endpoint: owned.server,
        endpointAuthorizer: permissiveMcpEndpointAuthorizerForTests(),
        protocolFactory: () => protocol,
      }),
  });

  _setMcpConnectionManagerForTests(manager);
  _setMcpExecutionBrokerForTests(new McpExecutionBroker(manager));

  return protocol;
}

async function seedUser(
  input: RunInput,
  testCase: Case,
): Promise<{ userId: string; threadId: string }> {
  const userId = `eval_cm_${randomUUID().slice(0, 12)}`;

  await db()
    .insert(user)
    .values({ id: userId, name: "Owner", email: `${userId}@example.test` });
  // What the user-created hook runs in production, then the owner's GitHub rule. The default
  // `gated` mode puts a card on every call, so every GitHub read would wait for a card in both
  // modes, and no read could run in a script.
  await ensureDefaultActionPolicyForUser(userId);
  await db()
    .update(userActionPolicies)
    .set({ integrationRules: OWNER_INTEGRATION_RULES })
    .where(eq(userActionPolicies.userId, userId));

  // Code Mode is on by default (ADR-0124 amendment 2026-11-19), so each mode writes its row.
  await settings({ userId }).set(CODE_MODE_READ_PATH_FEATURE_KEY, input.mode === "code_mode");

  const connection = await ensureConnection({
    userId,
    label: "GitHub",
    instanceKey: "default",
    canonicalResource: GITHUB_MCP_ENDPOINT_HREF,
    endpoint: new URL(GITHUB_MCP_ENDPOINT_HREF),
  });

  return { userId, threadId: await seedThread(userId, connection.id, testCase) };
}

async function seedThread(userId: string, connectionId: string, testCase: Case): Promise<string> {
  await getMcpConnectionManager().openForOwner(connectionId);

  if (testCase.gated) {
    const descriptor = GITHUB_CATALOG.find((tool) => tool.name === "get_file_contents");

    if (!descriptor) throw new Error("the catalog has no get_file_contents");

    await upsertToolPolicy({
      userId,
      connectionId,
      remoteName: descriptor.name,
      descriptorHash: descriptorHash(descriptor),
      riskTier: "high",
      effectClass: "read",
      retryContract: "never",
    });
  }

  const [thread] = await db()
    .insert(chatThreads)
    .values({ userId, title: "Code Mode paired eval" })
    .returning({ id: chatThreads.id });

  if (!thread) throw new Error("no thread row");

  return thread.id;
}

/** Approve each pending card of the run, as the user would. Returns the count. */
async function approvePendingCards(userId: string, runId: string): Promise<number> {
  const pending = await db()
    .select({ id: actionStagings.id, rowVersion: actionStagings.rowVersion })
    .from(actionStagings)
    .where(and(eq(actionStagings.runId, runId), eq(actionStagings.status, "pending")));

  for (const staging of pending) {
    const outcome = await stagedAction({ userId, stagingId: staging.id }).decide({
      decision: "approve",
      expectedRowVersion: staging.rowVersion,
      approval: { kind: "decide", decidedInput: undefined },
    });

    if (outcome.kind !== "decided") {
      throw new Error(`the approval of ${staging.id} returned ${JSON.stringify(outcome)}`);
    }
  }

  return pending.length;
}

/** Run the turn to its end in this process. Returns the cards that the eval approved. */
async function driveRun(userId: string, runId: string): Promise<number> {
  const deadline = Date.now() + RUN_DEADLINE_MS;
  let cards = 0;

  while (Date.now() < deadline) {
    const outcome = await runOnce(runId);

    switch (outcome.kind) {
      case "completed":
        return cards;
      case "failed":
        throw new Error(`the run failed: ${outcome.error}`);
      case "advanced":
        continue;
      case "deferred":
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, outcome.retryAt.getTime() - Date.now())),
        );
        continue;
      case "interrupted":
      case "blocked":
      case "skipped": {
        const approved = await approvePendingCards(userId, runId);
        cards += approved;

        if (approved > 0) continue;

        const [run] = await db()
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, runId));

        if (run?.status === "completed") return cards;

        throw new Error(`the run stopped with ${outcome.kind} and no card (status ${run?.status})`);
      }
    }
  }

  throw new Error(`the run passed its ${RUN_DEADLINE_MS} ms deadline`);
}

interface RunUsage {
  totalTokens: number;
  costUsd: number;
  maxInputTokens: number;
  chatSteps: number;
  servedModels: string[];
}

/** Every metered call of the run. Read before the user delete, which cascades to the rows. */
async function readRunUsage(runId: string): Promise<RunUsage> {
  // The metering rows settle in the background.
  await flushMeteringWrites();

  const calls = await db()
    .select({
      stepId: apiCallLog.stepId,
      model: apiCallLog.model,
      input: apiCallLog.inputTokens,
      output: apiCallLog.outputTokens,
      costUsd: apiCallLog.costUsd,
    })
    .from(apiCallLog)
    .where(eq(apiCallLog.runId, runId));

  // The step id is `<runId>:chat-turn:<n>`; a title or a compaction call has another one.
  const chatCalls = calls.filter((call) => call.stepId?.includes(":chat-turn:"));

  return {
    totalTokens: calls.reduce((sum, call) => sum + (call.input ?? 0) + (call.output ?? 0), 0),
    costUsd: calls.reduce((sum, call) => sum + Number(call.costUsd), 0),
    maxInputTokens: Math.max(0, ...calls.map((call) => call.input ?? 0)),
    chatSteps: chatCalls.length,
    servedModels: [...new Set(chatCalls.map((call) => call.model))],
  };
}

const NO_USAGE: RunUsage = {
  totalTokens: 0,
  costUsd: 0,
  maxInputTokens: 0,
  chatSteps: 0,
  servedModels: [],
};

function factsStated(answer: string, facts: readonly string[]): number {
  const text = answer.toLowerCase();

  return facts.filter((fact) => text.includes(fact.toLowerCase())).length / facts.length;
}

async function measureRun(input: RunInput): Promise<RunMeasure> {
  boot();
  const testCase = CASES.find((candidate) => candidate.kind === input.kind);

  if (!testCase) throw new Error(`no case ${input.kind}`);

  const protocol = installGithub();
  const { userId, threadId } = await seedUser(input, testCase);
  const startedAt = Date.now();
  let runId: string | null = null;

  try {
    const started = await startChatTurn({
      userId,
      threadId,
      userMessageId: `msg_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      content: testCase.prompt,
    });

    if (started.outcome !== "started" || !started.runId) {
      throw new Error(`the turn did not start: ${started.outcome}`);
    }

    const startedRunId = started.runId;
    runId = startedRunId;
    const approvalCards = await driveRun(userId, startedRunId);
    const latencyMs = Date.now() - startedAt;

    const [message] = await db()
      .select({ content: chatMessages.content, toolCalls: chatMessages.toolCalls })
      .from(chatMessages)
      .where(eq(chatMessages.id, started.assistantMessageId));

    const usage = await readRunUsage(startedRunId);
    const answer = message?.content ?? "";

    return {
      ...input,
      model: chatModelId,
      servedModels: usage.servedModels,
      error: null,
      quality: factsStated(answer, testCase.facts),
      latencyMs,
      totalTokens: usage.totalTokens,
      costUsd: usage.costUsd,
      maxInputTokens: usage.maxInputTokens,
      modelSteps: usage.chatSteps,
      approvalCards,
      firstStepSchemaTokens: surfaceTokens.get(startedRunId)?.[0] ?? null,
      toolCalls: (message?.toolCalls ?? []).map((call) => call.toolName),
      toolTrail: (message?.toolCalls ?? []).map(
        (call) => `${call.toolName} ${call.status}: ${(call.resultPreview ?? "").slice(0, 400)}`,
      ),
      remoteCalls: [...protocol.calls],
      answer,
    };
  } catch (error) {
    // A failed run still spent money, so its cost and its models are read. Its tokens stay 0,
    // as before, so the token medians do not change.
    const usage = runId ? await readRunUsage(runId).catch(() => NO_USAGE) : NO_USAGE;

    return {
      ...input,
      model: chatModelId,
      servedModels: usage.servedModels,
      error: toMessage(error),
      quality: 0,
      latencyMs: Date.now() - startedAt,
      totalTokens: 0,
      costUsd: usage.costUsd,
      maxInputTokens: usage.maxInputTokens,
      modelSteps: 0,
      approvalCards: 0,
      firstStepSchemaTokens: runId ? (surfaceTokens.get(runId)?.[0] ?? null) : null,
      toolCalls: [],
      toolTrail: [],
      remoteCalls: [...protocol.calls],
      answer: "",
    };
  } finally {
    await db()
      .delete(user)
      .where(inArray(user.id, [userId]));
  }
}

// ---------------------------------------------------------------------------
// The verdict of the owner's rule (2026-11-18), written when the last run ends.
// ---------------------------------------------------------------------------

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? (sorted[middle] ?? Number.NaN)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

interface ModeSummary {
  quality: number;
  latencyMs: number;
  totalTokens: number;
  costUsd: number;
  maxInputTokens: number;
  modelSteps: number;
  approvalCards: number;
  firstStepSchemaTokens: number;
  errors: number;
}

function summarize(runs: readonly RunMeasure[]): ModeSummary {
  return {
    quality: median(runs.map((run) => run.quality)),
    latencyMs: median(runs.map((run) => run.latencyMs)),
    totalTokens: median(runs.map((run) => run.totalTokens)),
    costUsd: median(runs.map((run) => run.costUsd)),
    maxInputTokens: median(runs.map((run) => run.maxInputTokens)),
    modelSteps: median(runs.map((run) => run.modelSteps)),
    approvalCards: median(runs.map((run) => run.approvalCards)),
    firstStepSchemaTokens: median(
      runs.flatMap((run) =>
        run.firstStepSchemaTokens === null ? [] : [run.firstStepSchemaTokens],
      ),
    ),
    errors: runs.filter((run) => run.error !== null).length,
  };
}

interface KindVerdict {
  kind: CaseKind;
  direct: ModeSummary;
  codeMode: ModeSummary;
  checks: string[];
  pass: boolean;
}

function judgeKind(kind: CaseKind, direct: ModeSummary, codeMode: ModeSummary): KindVerdict {
  const checks: string[] = [];
  let pass = true;

  const check = (ok: boolean, text: string): void => {
    checks.push(`${ok ? "PASS" : "FAIL"} ${text}`);
    pass &&= ok;
  };

  check(codeMode.errors === 0 && direct.errors === 0, "every run finished");
  check(codeMode.quality >= direct.quality, "quality is not lower");
  check(codeMode.approvalCards <= direct.approvalCards, "approval cards are not more");

  if (kind === "fan_out" || kind === "dependent_reads") {
    check(
      codeMode.totalTokens < direct.totalTokens || codeMode.latencyMs < direct.latencyMs,
      "median tokens or median latency is lower",
    );
  }

  if (kind === "single_lookup") {
    check(
      codeMode.totalTokens <= direct.totalTokens * SINGLE_LOOKUP_TOLERANCE &&
        codeMode.latencyMs <= direct.latencyMs * SINGLE_LOOKUP_TOLERANCE,
      "median tokens and median latency are at most 20% worse",
    );
  }

  return { kind, direct, codeMode, checks, pass };
}

const results: RunMeasure[] = [];

function summaryRow(mode: string, summary: ModeSummary): string {
  return `| ${mode} | ${summary.quality.toFixed(2)} | ${Math.round(summary.latencyMs / 1000)} s | ${summary.totalTokens} | $${summary.costUsd.toFixed(4)} | ${summary.maxInputTokens} | ${summary.modelSteps} | ${summary.approvalCards} | ${summary.firstStepSchemaTokens} | ${summary.errors} |`;
}

function writeReport(): void {
  const verdicts = CASES.map((testCase) =>
    judgeKind(
      testCase.kind,
      summarize(results.filter((run) => run.kind === testCase.kind && run.mode === "direct")),
      summarize(results.filter((run) => run.kind === testCase.kind && run.mode === "code_mode")),
    ),
  );

  const lines = [
    `# Code Mode paired evaluation on ${chatModelId}, ${new Date().toISOString()}`,
    "",
    `Total cost: $${results.reduce((sum, run) => sum + run.costUsd, 0).toFixed(4)} over ${results.length} runs.`,
    "",
    `Verdict: ${verdicts.every((verdict) => verdict.pass) ? "Code Mode meets the owner's rule." : "Code Mode does not meet the owner's rule."}`,
    "",
  ];

  for (const verdict of verdicts) {
    lines.push(
      `## ${verdict.kind}`,
      "",
      "| Mode | Quality | Latency | Tokens | Cost | Largest call input | Steps | Cards | First-step schema tokens | Errors |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      summaryRow("direct", verdict.direct),
      summaryRow("code_mode", verdict.codeMode),
      "",
      ...verdict.checks.map((text) => `- ${text}`),
      "",
    );
  }

  lines.push("## Runs", "", "```json", JSON.stringify(results, null, 2), "```", "");
  mkdirSync(REPORT_DIR, { recursive: true });

  const file = path.join(
    REPORT_DIR,
    `${new Date().toISOString().replace(/[:.]/g, "")}-${PAIRED_MODEL}.md`,
  );

  writeFileSync(file, lines.join("\n"));
  console.log(`[code-mode-paired] report: ${file}`);
}

/** A dev filter, for example `CODE_MODE_PAIRED_ONLY=fan_out:code_mode`. The full run has none. */
const ONLY = process.env.CODE_MODE_PAIRED_ONLY?.split(":");

const RUNS: RunInput[] = CASES.flatMap((testCase) =>
  Array.from({ length: ONLY ? 1 : REPEATS }, (_, repeat) =>
    MODES.map((mode) => ({ kind: testCase.kind, mode, repeat })),
  ).flat(),
).filter((run) => !ONLY || (run.kind === ONLY[0] && (!ONLY[1] || run.mode === ONLY[1])));

evalite<RunInput, RunMeasure, null>(
  `Code Mode — the paired evaluation (ADR-0124), ${PAIRED_MODEL}`,
  {
    data: () => RUNS.map((input) => ({ input, expected: null })),
    task: async (input) => {
      const measure = await measureRun(input);
      results.push(measure);

      if (results.length === RUNS.length) {
        writeReport();
        await closeRedis();
        await closeConnections();
      }

      return measure;
    },
    scorers: [
      {
        name: "The answer states the planted facts",
        scorer: ({ output }) => ({
          score: output.quality,
          metadata: `${output.model} ${output.mode} ${output.kind}#${output.repeat}; ${output.error ?? `answer: ${output.answer.slice(0, 300)}`}`,
        }),
      },
      {
        name: "The run finished",
        scorer: ({ output }) => ({
          score: output.error === null ? 1 : 0,
          metadata: `model=${output.model}; served=[${output.servedModels.join(", ")}]; latency=${output.latencyMs} ms; tokens=${output.totalTokens}; cost=$${output.costUsd.toFixed(4)}; largest input=${output.maxInputTokens}; steps=${output.modelSteps}; cards=${output.approvalCards}; first-step schema tokens=${output.firstStepSchemaTokens}; tools=[${output.toolCalls.join(", ")}]; remote=[${output.remoteCalls.join(", ")}]`,
        }),
      },
    ],
  },
);
