import path from "node:path";
import {
  type ChatModelTier,
  getChatModel,
  getChatProviderOptions,
  getSubAgentModel,
} from "@alfred/ai";
import {
  calendarListEventsInput,
  fetchUrlInput,
  gmailReadMessageInput,
  gmailSearchInput,
  readUserContextInput,
  webSearchInput,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { type Tool, generateText, stepCountIs, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { z } from "zod";
import { formatDateGrounding } from "../src/modules/agent/grounding";
import {
  awaitSubAgentInputSchema,
  spawnSubAgentInputSchema,
} from "../src/modules/agent/sub-agents";
import { buildChatSystemPrompt } from "../src/modules/agent/workflows/chat-turn";
import { buildSubAgentSystemPrompt } from "../src/modules/agent/workflows/user-authored-brief";

// ADR-0077 amendment: behavioral guard for the boss charter. The old rulebook
// routed people questions inward (memory + Gmail) and never mentioned the live
// web; the 2026-07-02 Sakshi production thread re-asked for "more" three times
// and still made zero web_search calls, including on Deep/Opus. These cases test
// the source class the model reaches for, not a brittle exact path.
//
// Run locally with apps/server/.env populated (ANTHROPIC_API_KEY +
// GOOGLE_GENERATIVE_AI_API_KEY, matching serverEnv): `pnpm --filter @alfred/api eval`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

const NOW = new Date("2026-07-02T07:30:00Z");
const TIMEZONE = "Asia/Kolkata";
const EVAL_TIMEOUT_MS = 60_000;

const READ_CONTEXT_TOOL = "system.read_user_context";
const WEB_SEARCH_TOOL = "system.web_search";
const SPAWN_SUB_AGENT_TOOL = "system.spawn_sub_agent";
const AWAIT_SUB_AGENT_TOOL = "system.await_sub_agent";
const GMAIL_SEARCH_TOOL = "gmail.search";
const GMAIL_READ_MESSAGE_TOOL = "gmail.read_message";
const CALENDAR_TOOL = "calendar.list_events";
const FETCH_URL_TOOL = "system.fetch_url";
const GITHUB_SEARCH_TOOL = "github.search";
const GITHUB_GET_PR_TOOL = "github.get_pull_request";

const TIERS: ChatModelTier[] = ["standard", "deep"];

// Case-specific source tools. A thorough investigation discovers leads and then
// drills into one named record from the same source class; unrelated tool spam
// must not satisfy the depth check.
const WEB_INVESTIGATION_TOOLS = new Set<string>([
  READ_CONTEXT_TOOL,
  WEB_SEARCH_TOOL,
  FETCH_URL_TOOL,
]);
const GITHUB_INVESTIGATION_TOOLS = new Set<string>([
  READ_CONTEXT_TOOL,
  GITHUB_SEARCH_TOOL,
  GITHUB_GET_PR_TOOL,
]);

const CONNECTED_SUMMARY = [
  "You are connected to these integrations right now — call each as integration.action (for example calendar.list_events). Treat this list as authoritative: do not offer or attempt an integration that is not on it.",
  "- gmail.search, gmail.read_message — the user's email",
  "- calendar.list_events, calendar.create_event — the user's calendar",
  "- system.read_user_context — Alfred's stored memory about the user",
  "- system.web_search — live public web search",
  "- system.fetch_url — read a known URL's page as text",
  "- system.spawn_sub_agent, system.await_sub_agent — delegate and await a focused multi-step investigation",
].join("\n");

const SYSTEM = buildChatSystemPrompt(formatDateGrounding(TIMEZONE, NOW), CONNECTED_SUMMARY);

const WEB_SEARCH_DESCRIPTION =
  "Search the live public web for current facts, public background on people or companies, and information outside Alfred's memory or connected services. Returns a synthesized answer plus result URLs/citations; use system.fetch_url on a promising result when you need to verify or read the page behind the search result.";

interface ToolCall {
  name: string;
  input: unknown;
}

interface TaskOutput {
  toolNames: string[];
  /** Every tool call in order, with its input — needed to tell distinct
   * research angles apart (e.g. two web_search calls with different queries). */
  calls: ToolCall[];
  first: string | null;
  text: string;
}

// Structural view of the bits of a generateText result we read — avoids
// threading the SDK's TOOLS/OUTPUT generics through a shared helper.
interface GenerateTextView {
  steps: ReadonlyArray<{ toolCalls: ReadonlyArray<{ toolName: string; input: unknown }> }>;
  text: string;
}

function collectOutput(result: GenerateTextView): TaskOutput {
  // `result.steps` holds every step (a single generateText with no stopWhen
  // still yields one step), so this reads both single-shot and multi-step runs.
  const calls: ToolCall[] = result.steps.flatMap((step) =>
    step.toolCalls.map((call) => ({ name: call.toolName, input: call.input })),
  );
  const toolNames = calls.map((c) => c.name);
  return { toolNames, calls, first: toolNames[0] ?? null, text: result.text };
}

function callQuery(input: unknown): string | null {
  if (input && typeof input === "object" && "query" in input) {
    const q = (input as { query: unknown }).query;
    return typeof q === "string" ? q.toLowerCase().trim() : null;
  }
  return null;
}

/**
 * The Sakshi bug in one assertion: after a thin first pass the boss ran a
 * single web_search, accepted the punt, and stopped — 2 of 24 tool-steps used.
 * "Depth" is satisfied by any of: two distinct web_search angles, a web_search
 * followed by a fetch_url drill, or delegating the whole investigation to a
 * sub-agent (which runs its own loop). Anything less is one-and-done.
 */
function bossDepthVerdict(calls: ToolCall[]): { ok: boolean; detail: string } {
  const webQueries = new Set<string>();
  let usedWeb = false;
  let usedFetch = false;
  let delegated = false;
  for (const c of calls) {
    if (c.name === WEB_SEARCH_TOOL) {
      usedWeb = true;
      const q = callQuery(c.input);
      if (q) webQueries.add(q);
    } else if (c.name === FETCH_URL_TOOL) {
      usedFetch = true;
    } else if (c.name === SPAWN_SUB_AGENT_TOOL) {
      delegated = true;
    }
  }
  const ok = delegated || webQueries.size >= 2 || (usedWeb && usedFetch);
  return {
    ok,
    detail: `distinct web queries=${webQueries.size}, web+fetch=${usedWeb && usedFetch}, delegated=${delegated}`,
  };
}

/**
 * The integration-agnostic version of the same idea, for the research
 * sub-agent: it should work at least two distinct investigative actions AND
 * open at least one specific record (drill), whatever the source — a person on
 * the web, a PR on GitHub, a task in Gmail. This is what makes depth a
 * *capability*, not a web-only behavior.
 */
function investigationDepthVerdict(
  calls: ToolCall[],
  kind: "web" | "github",
): { ok: boolean; detail: string } {
  const allowed = kind === "web" ? WEB_INVESTIGATION_TOOLS : GITHUB_INVESTIGATION_TOOLS;
  const relevant = calls.filter((c) => allowed.has(c.name) && c.name !== READ_CONTEXT_TOOL);
  const offDomain = calls.filter((c) => !allowed.has(c.name));
  const distinct = new Set(relevant.map((c) => `${c.name}:${JSON.stringify(c.input)}`));
  const searched = relevant.some(
    (c) => c.name === (kind === "web" ? WEB_SEARCH_TOOL : GITHUB_SEARCH_TOOL),
  );
  const drilled = relevant.some(
    (c) => c.name === (kind === "web" ? FETCH_URL_TOOL : GITHUB_GET_PR_TOOL),
  );
  const ok = offDomain.length === 0 && distinct.size >= 2 && searched && drilled;
  return {
    ok,
    detail: `kind=${kind}, distinct relevant actions=${distinct.size}, searched=${searched}, drilled a record=${drilled}, off-domain=[${offDomain.map((c) => c.name).join(", ")}], tools=[${calls.map((c) => c.name).join(", ")}]`,
  };
}

interface SourceCase {
  input: string;
  expected: "web" | "calendar";
}

const SOURCE_CASES: SourceCase[] = [
  {
    input: "who is Lina Khan?",
    expected: "web",
  },
  {
    input: "what's the latest on Anthropic?",
    expected: "web",
  },
  {
    input: "what's on my calendar tomorrow?",
    expected: "calendar",
  },
];

function providerOptions(tier: ChatModelTier = "standard"): Record<string, never> {
  // Mirrors the AlfredAgent boundary cast used in other evals.
  return getChatProviderOptions(tier) as unknown as Record<string, never>;
}

function toolSurface(): Record<string, Tool> {
  return {
    [READ_CONTEXT_TOOL]: tool({
      description:
        "Read Alfred's stored context about the user's profile, preferences, relationships, people, projects, and recent memory.",
      inputSchema: readUserContextInput,
    }),
    [WEB_SEARCH_TOOL]: tool({
      description: WEB_SEARCH_DESCRIPTION,
      inputSchema: webSearchInput,
    }),
    [SPAWN_SUB_AGENT_TOOL]: tool({
      description:
        "Spawn one focused sub-agent run for a multi-step investigation across memory, connected services, and the web.",
      inputSchema: spawnSubAgentInputSchema,
    }),
    [AWAIT_SUB_AGENT_TOOL]: tool({
      description: "Wait for a spawned sub-agent to finish and read its real result.",
      inputSchema: awaitSubAgentInputSchema,
    }),
    [GMAIL_SEARCH_TOOL]: tool({
      description:
        "Search Gmail messages. Each hit carries sender, subject, snippet, timestamp, ids, and a url.",
      inputSchema: gmailSearchInput,
    }),
    [GMAIL_READ_MESSAGE_TOOL]: tool({
      description: "Read one Gmail message body by message id or document id.",
      inputSchema: gmailReadMessageInput,
    }),
    [CALENDAR_TOOL]: tool({
      description:
        "List Google Calendar events. Use this for calendar availability and event count questions.",
      inputSchema: calendarListEventsInput,
    }),
  };
}

async function runSourceChoice(input: string): Promise<TaskOutput> {
  const result = await generateText({
    model: getChatModel("standard"),
    system: SYSTEM,
    prompt: input,
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    providerOptions: providerOptions(),
    tools: toolSurface(),
  });
  return collectOutput(result);
}

evalite<string, TaskOutput, SourceCase["expected"]>("Boss judgment — source ladder", {
  data: () => SOURCE_CASES.map((c) => ({ input: c.input, expected: c.expected })),
  task: async (input) => {
    void serverEnv().ANTHROPIC_API_KEY;
    try {
      return await runSourceChoice(input);
    } catch (err) {
      return {
        toolNames: [],
        calls: [],
        first: null,
        text: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  scorers: [
    {
      name: "Reaches the expected source class",
      scorer: ({ output, expected }) => {
        const reachedWeb = output.toolNames.includes(WEB_SEARCH_TOOL);
        const reachedCalendar = output.toolNames.includes(CALENDAR_TOOL);
        const ok = expected === "web" ? reachedWeb : reachedCalendar;
        return {
          score: ok ? 1 : 0,
          metadata: ok
            ? `called [${output.toolNames.join(", ")}]`
            : `expected ${expected}; called [${output.toolNames.join(", ") || "no tool"}]; replied: ${output.text.slice(0, 200)}`,
        };
      },
    },
    {
      name: "Does not over-search calendar requests",
      scorer: ({ output, expected }) => {
        if (expected !== "calendar") return { score: 1, metadata: "n/a" };
        const ok =
          output.toolNames.includes(CALENDAR_TOOL) && !output.toolNames.includes(WEB_SEARCH_TOOL);
        return {
          score: ok ? 1 : 0,
          metadata: ok
            ? `calendar without web: [${output.toolNames.join(", ")}]`
            : `calendar control over-reached or missed: [${output.toolNames.join(", ") || "no tool"}]`,
        };
      },
    },
  ],
});

const clickUpSearchResultSchema = z.object({
  messages: z.array(
    z.object({
      from: z.string(),
      subject: z.string(),
      snippet: z.string(),
      authoredAt: z.string(),
      url: z.string(),
    }),
  ),
});

async function runThinPersonResearchReplay(
  userMessage: string,
  tier: ChatModelTier,
): Promise<TaskOutput> {
  const result = await generateText({
    model: getChatModel(tier),
    system: SYSTEM,
    messages: [
      { role: "user", content: "what do i know about sakshi" },
      {
        role: "assistant",
        content:
          "Sakshi Jindal appears in a couple of your calendar-invite emails, but I only have thin internal context on her.",
      },
      { role: "user", content: userMessage },
    ],
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    providerOptions: providerOptions(tier),
    stopWhen: stepCountIs(5),
    tools: {
      [READ_CONTEXT_TOOL]: tool({
        description: "Read Alfred's stored context about the user's people and projects.",
        inputSchema: readUserContextInput,
        execute: async () => ({
          profile: null,
          entities: [{ name: "Sakshi Jindal", summary: "Seen in recent work context only." }],
          facts: [],
          recentMemory: [],
        }),
      }),
      [GMAIL_SEARCH_TOOL]: tool({
        description:
          "Search Gmail messages. Each hit carries sender, subject, snippet, timestamp, ids, and a url.",
        inputSchema: gmailSearchInput,
        execute: async () =>
          clickUpSearchResultSchema.parse({
            messages: [
              {
                from: "ClickUp <notifications@clickup.com>",
                subject: "Sakshi Jindal mentioned you in a task",
                snippet:
                  "Sakshi Jindal commented on a ClickUp task. Open ClickUp to see the full task thread and project details.",
                authoredAt: "2026-07-01T10:15:00.000Z",
                url: "https://mail.google.com/mail/u/0/#all/clickup_sakshi_1",
              },
              {
                from: "ClickUp <notifications@clickup.com>",
                subject: "Task updated by Sakshi Jindal",
                snippet:
                  "A task involving Sakshi Jindal was updated in ClickUp. The details are in ClickUp.",
                authoredAt: "2026-07-01T09:00:00.000Z",
                url: "https://mail.google.com/mail/u/0/#all/clickup_sakshi_2",
              },
            ],
            nextPageToken: null,
          }),
      }),
      [GMAIL_READ_MESSAGE_TOOL]: tool({
        description: "Read one Gmail message body by message id or document id.",
        inputSchema: gmailReadMessageInput,
        execute: async () => ({
          messageId: "clickup_sakshi_1",
          threadId: "clickup_thread",
          from: "ClickUp <notifications@clickup.com>",
          subject: "Sakshi Jindal mentioned you in a task",
          text: "Sakshi Jindal commented on a ClickUp task. The email only contains a notification preview; open ClickUp for the task thread and project details.",
          url: "https://mail.google.com/mail/u/0/#all/clickup_sakshi_1",
        }),
      }),
      [WEB_SEARCH_TOOL]: tool({
        description: WEB_SEARCH_DESCRIPTION,
        inputSchema: webSearchInput,
        // Post-A return shape: `{ ok, query, answer, citations, results, searchQueries }`.
        // Here the public web genuinely has nothing on point (a private-work
        // colleague), so the honest depth move is to name the hidden richer
        // source (ClickUp), not to keep hammering the web.
        execute: async ({ query }) => ({
          ok: true,
          query,
          answer:
            "No public profile or background surfaced for this person in a work context; the search returned nothing on point.",
          citations: [],
          results: [],
          searchQueries: [query],
        }),
      }),
      [FETCH_URL_TOOL]: tool({
        description: "Read the contents of a known http(s) URL as sanitized text.",
        inputSchema: fetchUrlInput,
        execute: async ({ url }) => ({
          ok: true,
          finalUrl: url,
          title: "ClickUp notification",
          text: "This links back into the ClickUp app; the page requires signing in to ClickUp to see the task thread and project details.",
        }),
      }),
      [SPAWN_SUB_AGENT_TOOL]: tool({
        description:
          "Spawn one focused sub-agent run for a multi-step investigation across memory, connected services, and the web.",
        inputSchema: spawnSubAgentInputSchema,
        execute: async () => ({
          childRunId: "child_eval_sakshi",
          status: "running",
        }),
      }),
      [AWAIT_SUB_AGENT_TOOL]: tool({
        description: "Wait for a spawned sub-agent to finish and read its real result.",
        inputSchema: awaitSubAgentInputSchema,
        execute: async () => ({
          status: "completed",
          output:
            "Memory and Gmail are thin; ClickUp likely has the task details, and no confident public result was found.",
        }),
      }),
    },
  });
  return collectOutput(result);
}

interface ReplayCase {
  message: string;
  tier: ChatModelTier;
}

const REPLAY_MESSAGES = ["find more about her", "can we know something more about her?"];

evalite<ReplayCase, TaskOutput, null>("Boss judgment — thin person research replay", {
  // The bug appeared on Deep/Opus as well as the everyday tier, so exercise both.
  data: () =>
    TIERS.flatMap((tier) =>
      REPLAY_MESSAGES.map((message) => ({ input: { message, tier }, expected: null })),
    ),
  task: async (input) => {
    void serverEnv().ANTHROPIC_API_KEY;
    try {
      return await runThinPersonResearchReplay(input.message, input.tier);
    } catch (err) {
      return {
        toolNames: [],
        calls: [],
        first: null,
        text: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  scorers: [
    {
      name: "Reaches a new public/research source after thin internal results",
      scorer: ({ output }) => {
        const ok =
          output.toolNames.includes(WEB_SEARCH_TOOL) ||
          output.toolNames.includes(SPAWN_SUB_AGENT_TOOL);
        return {
          score: ok ? 1 : 0,
          metadata: ok
            ? `tool path: ${output.toolNames.join(" -> ")}`
            : `stayed internal only: tools=[${output.toolNames.join(", ")}]; text=${output.text.slice(0, 260)}`,
        };
      },
    },
    {
      name: "Names ClickUp as the richer unavailable source",
      scorer: ({ output }) => {
        const text = output.text.toLowerCase();
        const ok = text.includes("clickup") && (text.includes("unlock") || text.includes("detail"));
        return {
          score: ok ? 1 : 0,
          metadata: ok
            ? output.text.slice(0, 240)
            : `did not name the hidden source clearly; tools=[${output.toolNames.join(", ")}]; text=${output.text.slice(0, 240)}`,
        };
      },
    },
    {
      name: "Does not offer web search as an untried next step",
      scorer: ({ output }) => {
        const searchedOrDelegated =
          output.toolNames.includes(WEB_SEARCH_TOOL) ||
          output.toolNames.includes(SPAWN_SUB_AGENT_TOOL);
        const text = output.text.toLowerCase();
        const puntsToFutureWeb =
          text.includes("i can look") ||
          text.includes("i can search") ||
          text.includes("if you know") ||
          text.includes("if you share");
        const ok = searchedOrDelegated || !puntsToFutureWeb;
        return {
          score: ok ? 1 : 0,
          metadata: ok
            ? "did not defer an available public lookup"
            : `offered lookup instead of doing it: tools=[${output.toolNames.join(", ")}]; text=${output.text.slice(0, 260)}`,
        };
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// Depth on a genuinely findable public person, on BOTH tiers.
//
// The ClickUp replay above tests recognizing a hidden *internal* source. This
// one is the actual Sakshi/Opus failure: a person the public web CAN answer,
// where the bug was running one web_search, accepting the punt, and stopping.
// The post-A web_search mock surfaces a candidate + a drillable citation even
// at low confidence (the old tool collapsed to "no confident match"), so the
// right move is to investigate — a second angle, a fetch_url drill, or delegate.
// ---------------------------------------------------------------------------

async function runPersonResearchDepth(
  userMessage: string,
  tier: ChatModelTier,
): Promise<TaskOutput> {
  const result = await generateText({
    model: getChatModel(tier),
    system: SYSTEM,
    messages: [
      { role: "user", content: "what do we know about priya nair?" },
      {
        role: "assistant",
        content:
          "I don't have anything on Priya Nair in Alfred's memory or your email — just the name so far.",
      },
      { role: "user", content: userMessage },
    ],
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    providerOptions: providerOptions(tier),
    stopWhen: stepCountIs(6),
    tools: {
      [READ_CONTEXT_TOOL]: tool({
        description: "Read Alfred's stored context about the user's people and projects.",
        inputSchema: readUserContextInput,
        execute: async () => ({ profile: null, entities: [], facts: [], recentMemory: [] }),
      }),
      [WEB_SEARCH_TOOL]: tool({
        description: WEB_SEARCH_DESCRIPTION,
        inputSchema: webSearchInput,
        execute: async ({ query }) => ({
          ok: true,
          query,
          answer:
            "A LinkedIn profile and a conference bio for a Priya Nair appear, but the match to your query isn't confirmed from this single search [1].",
          citations: [
            {
              url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/priya-linkedin",
              title: "linkedin.com",
            },
          ],
          results: [
            {
              url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/priya-linkedin",
              title: "linkedin.com",
            },
          ],
          searchQueries: [query],
        }),
      }),
      [FETCH_URL_TOOL]: tool({
        description: "Read the contents of a known http(s) URL as sanitized text.",
        inputSchema: fetchUrlInput,
        execute: async ({ url }) => ({
          ok: true,
          finalUrl: url,
          title: "Priya Nair — LinkedIn",
          text: "Priya Nair — Product Manager at Foobar (Bengaluru, India). Leads customer onboarding; previously an analyst. Speaks at product meetups.",
        }),
      }),
      [SPAWN_SUB_AGENT_TOOL]: tool({
        description:
          "Spawn one focused sub-agent run for a multi-step investigation across memory, connected services, and the web.",
        inputSchema: spawnSubAgentInputSchema,
        execute: async () => ({ childRunId: "child_eval_priya", status: "running" }),
      }),
      [AWAIT_SUB_AGENT_TOOL]: tool({
        description: "Wait for a spawned sub-agent to finish and read its real result.",
        inputSchema: awaitSubAgentInputSchema,
        execute: async () => ({
          status: "completed",
          output:
            "Priya Nair is a Product Manager at Foobar in Bengaluru per her LinkedIn and a conference bio, corroborated across two sources.",
        }),
      }),
    },
  });
  return collectOutput(result);
}

evalite<ReplayCase, TaskOutput, null>("Boss judgment — person research depth", {
  data: () =>
    TIERS.flatMap((tier) =>
      REPLAY_MESSAGES.map((message) => ({ input: { message, tier }, expected: null })),
    ),
  task: async (input) => {
    void serverEnv().ANTHROPIC_API_KEY;
    try {
      return await runPersonResearchDepth(input.message, input.tier);
    } catch (err) {
      return {
        toolNames: [],
        calls: [],
        first: null,
        text: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  scorers: [
    {
      name: "Investigates in depth (>=2 angles, a fetch_url drill, or delegation)",
      scorer: ({ output }) => {
        const v = bossDepthVerdict(output.calls);
        return {
          score: v.ok ? 1 : 0,
          metadata: `${v.detail}; text=${output.text.slice(0, 200)}`,
        };
      },
    },
    {
      name: "Reaches the public web or delegates (doesn't stay internal)",
      scorer: ({ output }) => {
        const ok =
          output.toolNames.includes(WEB_SEARCH_TOOL) ||
          output.toolNames.includes(SPAWN_SUB_AGENT_TOOL);
        return {
          score: ok ? 1 : 0,
          metadata: ok
            ? `tools=[${output.toolNames.join(", ")}]`
            : `stayed internal: tools=[${output.toolNames.join(", ")}]; text=${output.text.slice(0, 200)}`,
        };
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// Genericity guard (Yash's steer): depth is a *capability*, not a web-only
// behavior. The research sub-agent must investigate in depth across ANY source
// — a person on the web (search -> fetch_url) or a PR on GitHub (search ->
// get_pull_request). Same prompt (buildSubAgentSystemPrompt), two unrelated
// briefs; both must work >=2 distinct actions AND drill into a real record.
// ---------------------------------------------------------------------------

const SUB_CONNECTED_SUMMARY = [
  "You are connected to these tools right now — call each as integration.action:",
  "- system.web_search — live public web search",
  "- system.fetch_url — read a known URL's page as text",
  "- github.search, github.get_pull_request — the user's code",
  "- system.read_user_context — Alfred's stored memory about the user",
].join("\n");

const SUB_SYSTEM = buildSubAgentSystemPrompt(
  formatDateGrounding(TIMEZONE, NOW),
  SUB_CONNECTED_SUMMARY,
  "sub-eval",
);

const githubSearchInputMock = z.object({
  query: z.string(),
  type: z.string().optional(),
  state: z.string().optional(),
});
const githubGetPrInputMock = z.object({
  repo: z.string(),
  number: z.number(),
});

interface SubAgentCase {
  label: string;
  kind: "web" | "github";
  brief: string;
}

const SUB_AGENT_CASES: SubAgentCase[] = [
  {
    label: "web/person",
    kind: "web",
    brief:
      "Investigate the public professional background of Priya Nair, who works at a startup called Foobar — her role, location, and anything notable — and report what you find.",
  },
  {
    label: "github/pr",
    kind: "github",
    brief:
      "Investigate pull request #482 in the acme/web repository: what it changes, how big it is, and whether it looks ready to merge. Report what you find.",
  },
];

async function runSubAgentInvestigation(brief: string): Promise<TaskOutput> {
  const result = await generateText({
    model: getSubAgentModel(),
    system: SUB_SYSTEM,
    prompt: brief,
    timeout: { totalMs: EVAL_TIMEOUT_MS },
    stopWhen: stepCountIs(6),
    tools: {
      [WEB_SEARCH_TOOL]: tool({
        description: WEB_SEARCH_DESCRIPTION,
        inputSchema: webSearchInput,
        execute: async ({ query }) => ({
          ok: true,
          query,
          answer:
            "A LinkedIn profile and a company team page for a Priya Nair appear, but the details aren't confirmed from this single search [1].",
          citations: [
            {
              url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/priya-linkedin",
              title: "linkedin.com",
            },
          ],
          results: [
            {
              url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/priya-linkedin",
              title: "linkedin.com",
            },
          ],
          searchQueries: [query],
        }),
      }),
      [FETCH_URL_TOOL]: tool({
        description: "Read the contents of a known http(s) URL as sanitized text.",
        inputSchema: fetchUrlInput,
        execute: async ({ url }) => ({
          ok: true,
          finalUrl: url,
          title: "Priya Nair — profile",
          text: "Priya Nair — Product Manager at Foobar (Bengaluru). Leads customer onboarding; speaks at product meetups.",
        }),
      }),
      [GITHUB_SEARCH_TOOL]: tool({
        description:
          "Search GitHub issues and pull requests. Each hit carries type, number, title, repo, state, and url — a snippet, not the full record.",
        inputSchema: githubSearchInputMock,
        execute: async () => ({
          items: [
            {
              type: "pr",
              number: 482,
              title: "Refactor auth middleware",
              repo: "acme/web",
              state: "open",
              url: "https://github.com/acme/web/pull/482",
            },
          ],
        }),
      }),
      [GITHUB_GET_PR_TOOL]: tool({
        description:
          "Read one pull request's full detail by repo and number: title, body, changed files, additions/deletions, review state.",
        inputSchema: githubGetPrInputMock,
        execute: async () => ({
          number: 482,
          title: "Refactor auth middleware",
          state: "open",
          body: "Splits the auth middleware into per-provider handlers. One review still requested; CI is green.",
          additions: 240,
          deletions: 180,
          changedFiles: 7,
          reviewDecision: "REVIEW_REQUIRED",
        }),
      }),
      [READ_CONTEXT_TOOL]: tool({
        description: "Read Alfred's stored context about the user's people and projects.",
        inputSchema: readUserContextInput,
        execute: async () => ({ profile: null, entities: [], facts: [], recentMemory: [] }),
      }),
    },
  });
  return collectOutput(result);
}

evalite<SubAgentCase, TaskOutput, null>("Sub-agent — investigation depth (generic)", {
  data: () => SUB_AGENT_CASES.map((c) => ({ input: c, expected: null })),
  task: async (input) => {
    void serverEnv().ANTHROPIC_API_KEY;
    try {
      return await runSubAgentInvestigation(input.brief);
    } catch (err) {
      return {
        toolNames: [],
        calls: [],
        first: null,
        text: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  scorers: [
    {
      name: "Works >=2 distinct angles and drills a specific record",
      scorer: ({ output, input }) => {
        const v = investigationDepthVerdict(output.calls, input.kind);
        return { score: v.ok ? 1 : 0, metadata: v.detail };
      },
    },
    {
      name: "Does not conclude from a single lookup",
      scorer: ({ output }) => {
        const ok = output.calls.length >= 2;
        return {
          score: ok ? 1 : 0,
          metadata: `total tool calls=${output.calls.length}; tools=[${output.toolNames.join(", ")}]`,
        };
      },
    },
  ],
});
