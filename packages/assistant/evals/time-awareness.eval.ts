import path from "node:path";
import { route, toModelMessages } from "@alfred/ai";
import {
  CODE_RUN_TOOL,
  codeRunInput,
  currentTimeInput,
  type HostReadRefusal,
  type IanaTimezone,
  type JsonValue,
  mcpCallInput,
  mcpCallModelInput,
  mcpToolSearchInputSchema,
  parseIanaTimezone,
  toMessage,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { generateText, tool, type ModelMessage, type Tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { z } from "zod";
import { buildChatSystemPrompt } from "@alfred/assistant/chat/chat-turn";
import {
  takeTimeNote,
  type ChatReadPath,
  type ChatRunState,
} from "@alfred/assistant/chat/chat-turn-state";
import { appendSystemNote } from "@alfred/assistant/execution/transcript-notes";
import { selfIdentityGrounding } from "@alfred/assistant/settings";
import { registerBuiltinTools } from "../src/tool-runtime/builtin-tools";
import { readHostBindings } from "../src/tool-runtime/code-mode/host-bindings";
import { jsonBytes } from "../src/tool-runtime/code-mode/result-budget";
import { runReadProgram } from "../src/tool-runtime/code-mode/run-read-program";
import { newHostCallLedger } from "../src/tool-runtime/internal/dispatch/host-call-ledger";
import {
  getTool,
  listRegisteredTools,
  type HostReadOutcome,
  type HostReadRequest,
} from "../src/tool-runtime/internal/registry";
import { currentTimeSnapshot } from "../src/tool-runtime/internal/tools/system";
import { readRouteReasonText } from "../src/tool-runtime/read-route";
import { userMessageAt } from "./lib/grounding";
import { scoreTimeAnswer, type TimeAnswerExpectation } from "./lib/time-answer";

// ADR-0130 decision 7, amendment (f): a user message gets a saved `<time_note>` only at the first
// message of a thread, after a pause of `TIME_NOTE_PAUSE_MS` or more, and on a new local date.
// Otherwise the model must look up the time when the answer needs it: `system.current_time` today,
// `time.now()` in the sandbox after #1805. This eval measures two facts on Haiku 5.5: does the
// model look up the time when the answer needs it, and is the answer correct?
//
// The eval uses the production prompt, the production clock description, and the production time
// note. The clock is in the kernel, so each step offers it. Each step is one model call, and the
// eval dispatches the calls itself, as `chat-turn.ts` does. Before each step the eval asks the
// production `takeTimeNote` for the `[system]` note of a long step, and adds it with the
// production `appendSystemNote`. Only the export of case (d) moves the clock, so only case (d)
// can get a note. Its "model alone" control runs with no note.
// Run with apps/server/.env populated:
// `pnpm --filter @alfred/assistant exec evalite run time-awareness`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

registerBuiltinTools();

const TIMEZONE = parseIanaTimezone("Asia/Kolkata");

const EVAL_TIMEOUT_MS = 180_000;

/** Room to read the clock, read the calendar, and answer. */
const MAX_STEPS = 8;

const CURRENT_TIME_TOOL = "system.current_time";

const MCP_LIST_TOOLS_TOOL = "mcp.list_tools";

const MCP_CALL_TOOL = "mcp.call";

/** Wed 10 June 2026, IST. */
function ist(hourMinute: string): Date {
  return new Date(`2026-06-10T${hourMinute}:00+05:30`);
}

const STANDUP = /standup/i;

const VENDOR = /vendor/i;

const SAM = /\bSam\b/;

const DINNER = /dinner|\bAna\b/i;

const CALENDAR_EVENTS = [
  { summary: "Team standup", start: "2026-06-10T09:30:00+05:30", end: "2026-06-10T09:45:00+05:30" },
  {
    summary: "Vendor review",
    start: "2026-06-10T14:00:00+05:30",
    end: "2026-06-10T15:00:00+05:30",
  },
  { summary: "1:1 with Sam", start: "2026-06-10T18:30:00+05:30", end: "2026-06-10T19:00:00+05:30" },
  {
    summary: "Dinner with Ana",
    start: "2026-06-10T20:00:00+05:30",
    end: "2026-06-10T21:30:00+05:30",
  },
] as const;

const CALENDAR_CONNECTION = {
  id: "mcp_conn_google_calendar",
  instanceKey: "calendar",
  label: "Google Calendar",
};

const DRIVE_CONNECTION = {
  id: "mcp_conn_google_drive",
  instanceKey: "drive",
  label: "Google Drive",
};

const LIST_EVENTS_REMOTE = "list_events";

const EXPORT_FILE_REMOTE = "export_file";

/** The export of case (d) takes this long, so "now" moves while the run works. */
const EXPORT_DURATION_MS = 40 * 60_000;

const DESCRIPTORS = [
  {
    connection: CALENDAR_CONNECTION,
    name: LIST_EVENTS_REMOTE,
    description:
      "List the events on the user's primary calendar that overlap a time range. Arguments: timeMin and timeMax, both RFC3339 timestamps with a UTC offset (required).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        timeMin: { type: "string", description: "RFC3339 with offset, inclusive." },
        timeMax: { type: "string", description: "RFC3339 with offset, exclusive." },
      },
      required: ["timeMin", "timeMax"],
    },
  },
  {
    connection: DRIVE_CONNECTION,
    name: EXPORT_FILE_REMOTE,
    description:
      "Export a Drive file, found by its name, as a PDF. A large spreadsheet can take up to an hour to export; the call returns when the PDF is ready. Arguments: name (string), format ('pdf').",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, format: { type: "string", enum: ["pdf"] } },
      required: ["name"],
    },
  },
] as const;

type Descriptor = (typeof DESCRIPTORS)[number];

function searchHit(descriptor: Descriptor) {
  return {
    ref: { kind: "mcp", connectionId: descriptor.connection.id, remoteName: descriptor.name },
    namespace: descriptor.connection.instanceKey,
    connection: descriptor.connection,
    description: descriptor.description,
  };
}

/** The production `mcp.call` result of a completed call: one JSON text block. */
function completedMcpResult(payload: JsonValue): JsonValue {
  return {
    status: "completed",
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  };
}

/** An MCP tool error, as `mcp.call` returns it. */
function mcpToolError(text: string): JsonValue {
  return {
    ok: false,
    status: "tool_error",
    result: { isError: true, content: [{ type: "text", text }] },
  };
}

const RFC3339_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

const listEventsArgs = z.object({
  timeMin: z.string().regex(RFC3339_WITH_OFFSET),
  timeMax: z.string().regex(RFC3339_WITH_OFFSET),
});

/** Like Google Calendar: the events that overlap `[timeMin, timeMax)`. A bad range is an error. */
function listEvents(rawArgs: unknown): JsonValue {
  const parsed = listEventsArgs.safeParse(rawArgs);

  if (!parsed.success) {
    return mcpToolError(
      "Bad Request: timeMin and timeMax are required RFC3339 timestamps with a UTC offset, for example 2026-01-05T00:00:00+05:30.",
    );
  }

  const from = new Date(parsed.data.timeMin).getTime();
  const to = new Date(parsed.data.timeMax).getTime();

  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) {
    return mcpToolError("Bad Request: timeMax must be later than timeMin.");
  }

  const events = CALENDAR_EVENTS.filter(
    (event) => new Date(event.start).getTime() < to && new Date(event.end).getTime() > from,
  );

  return completedMcpResult({ timeZone: TIMEZONE, events: [...events] });
}

/** The clock of one run. The export of case (d) moves it forward. */
interface RunClock {
  now: Date;
}

interface RunRecord {
  /** Each tool call in order, with its model step and the eval clock's time at its dispatch. */
  calls: { toolName: string; step: number; at: string }[];
  /** The local times that `system.current_time` returned. */
  clockReads: Date[];
  /** True when a script read `Date`, which is not the user's clock. */
  scriptReadDate: boolean;
  exportedAt: Date | null;
}

function callConnected(
  call: z.infer<typeof mcpCallModelInput>,
  clock: RunClock,
  record: RunRecord,
): JsonValue {
  if (call.connectionId === CALENDAR_CONNECTION.id && call.remoteName === LIST_EVENTS_REMOTE) {
    return listEvents(call.arguments);
  }

  if (call.connectionId === DRIVE_CONNECTION.id && call.remoteName === EXPORT_FILE_REMOTE) {
    clock.now = new Date(clock.now.getTime() + EXPORT_DURATION_MS);
    record.exportedAt = clock.now;

    return completedMcpResult({
      name: "Q2 vendor spend.pdf",
      url: "https://drive.google.com/file/d/q2-vendor-spend-pdf/view",
    });
  }

  return mcpToolError("This MCP tool is not in the catalog.");
}

/** A fixture outcome, before {@link withCallFacts} adds what dispatch sets. */
type FakeOutcome =
  | { kind: "executed"; value: JsonValue }
  | { kind: "refused"; refusal: HostReadRefusal; message: string };

/** The call facts that dispatch sets. Copied from `code-mode-read.eval.ts`. */
async function withCallFacts(
  request: HostReadRequest,
  outcome: FakeOutcome,
): Promise<HostReadOutcome> {
  const call = {
    callId: `eval#${request.requestIndex}`,
    toolName: request.toolName,
    input: null,
    stagingId: null,
  };

  return outcome.kind === "executed"
    ? { ...outcome, bytes: jsonBytes(outcome.value), call, evidence: undefined }
    : { ...outcome, call };
}

const inspectToolArgs = z.object({ ref: z.object({ remoteName: z.string() }) });

/** The fake `hostRead` of a script: the calendar reads only. Drive is not on the Code Mode case. */
function fakeHostRead(request: HostReadRequest, clock: RunClock, record: RunRecord): FakeOutcome {
  const calendar = DESCRIPTORS.filter(
    (descriptor) => descriptor.connection === CALENDAR_CONNECTION,
  );

  if (request.toolName === MCP_LIST_TOOLS_TOOL) {
    return {
      kind: "executed",
      value: { status: "tools", tools: calendar.map(searchHit), nextCursor: null },
    };
  }

  if (request.toolName === "mcp.inspect_tool") {
    const parsed = inspectToolArgs.safeParse(request.input);

    const descriptor = calendar.find(
      (d) => parsed.success && d.name === parsed.data.ref.remoteName,
    );

    if (!descriptor) {
      return {
        kind: "refused",
        refusal: "invalid_input",
        message: "This MCP tool is not in the catalog.",
      };
    }

    return {
      kind: "executed",
      value: {
        status: "tool",
        ref: searchHit(descriptor).ref,
        connection: descriptor.connection,
        tool: {
          name: descriptor.name,
          description: descriptor.description,
          annotations: descriptor.annotations,
          inputSchema: descriptor.inputSchema,
        },
      },
    };
  }

  if (request.toolName === MCP_CALL_TOOL) {
    const call = mcpCallInput.safeParse(request.input);

    if (!call.success) {
      return {
        kind: "refused",
        refusal: "invalid_input",
        message: "Use the ref from mcp.list_tools.",
      };
    }

    return { kind: "executed", value: callConnected(call.data, clock, record) };
  }

  return {
    kind: "refused",
    refusal: "failed",
    message: `This eval has no data for ${request.toolName}`,
  };
}

const READ_TOOLS = listRegisteredTools().filter((registered) => registered.codeModeRead);

const CODE_RUN_DESCRIPTION = getTool(CODE_RUN_TOOL)?.description;

const CURRENT_TIME_DESCRIPTION = getTool(CURRENT_TIME_TOOL)?.description;

/** A direct `mcp.call` read in a `code_run` chat: the refusal of `refuseMisroutedRead`. */
const DIRECT_READ_REFUSAL: JsonValue = {
  status: "invalid_input",
  toolName: MCP_CALL_TOOL,
  message: `In this chat this call runs only inside system.code_run now. ${readRouteReasonText({ route: "script" })} Call mcp.read(ref, args) with this ref in a script.`,
};

const MCP_CALL_DESCRIPTION =
  "Invoke a tool on a connected MCP server. Supply the `connectionId` and `remoteName` of the ref returned by mcp.list_tools, plus `arguments` matching the tool schema.";

/** The tools of one step, and how each call dispatches. No `execute`: the eval dispatches. */
function stepTools(readPath: ChatReadPath): Record<string, Tool> {
  const tools: Record<string, Tool> =
    readPath === "code_run"
      ? {
          [CODE_RUN_TOOL]: tool({
            description: CODE_RUN_DESCRIPTION ?? "",
            inputSchema: codeRunInput,
          }),
          [MCP_CALL_TOOL]: tool({
            description: MCP_CALL_DESCRIPTION,
            inputSchema: mcpCallModelInput,
          }),
        }
      : {
          [MCP_LIST_TOOLS_TOOL]: tool({
            description:
              "Search the tools in all connected MCP catalogs. Returns compact hits with an exact `ref`, namespace, and connection identity. Scope with `namespace` or `connectionId`.",
            inputSchema: mcpToolSearchInputSchema,
          }),
          [MCP_CALL_TOOL]: tool({
            description: MCP_CALL_DESCRIPTION,
            inputSchema: mcpCallModelInput,
          }),
        };

  tools[CURRENT_TIME_TOOL] = tool({
    description: CURRENT_TIME_DESCRIPTION ?? "",
    inputSchema: currentTimeInput,
  });

  return tools;
}

interface DispatchContext {
  readPath: ChatReadPath;
  clock: RunClock;
  record: RunRecord;
  offered: ReadonlySet<string>;
  step: number;
}

async function dispatch(
  call: { toolName: string; input: unknown; invalid?: boolean | undefined },
  ctx: DispatchContext,
): Promise<JsonValue> {
  ctx.record.calls.push({
    toolName: call.toolName,
    step: ctx.step,
    at: ctx.clock.now.toISOString(),
  });

  if (!ctx.offered.has(call.toolName)) {
    return {
      status: "unknown_tool",
      toolName: call.toolName,
      message: `Unknown tool '${call.toolName}'.`,
    };
  }

  if (call.invalid === true) {
    return {
      status: "invalid_input",
      toolName: call.toolName,
      message: "The input does not match the tool schema.",
    };
  }

  if (call.toolName === CURRENT_TIME_TOOL) {
    ctx.record.clockReads.push(ctx.clock.now);

    return currentTimeSnapshot(TIMEZONE, ctx.clock.now);
  }

  if (call.toolName === MCP_LIST_TOOLS_TOOL) {
    const scope = mcpToolSearchInputSchema.safeParse(call.input);
    const connectionId = scope.success ? scope.data.connectionId : undefined;

    const hits = DESCRIPTORS.filter(
      (d) => connectionId === undefined || d.connection.id === connectionId,
    );

    return { status: "tools", tools: hits.map(searchHit), nextCursor: null };
  }

  if (call.toolName === MCP_CALL_TOOL) {
    const parsed = mcpCallModelInput.safeParse(call.input);

    if (!parsed.success)
      return { status: "invalid_input", toolName: MCP_CALL_TOOL, message: parsed.error.message };

    if (ctx.readPath === "code_run" && parsed.data.remoteName === LIST_EVENTS_REMOTE)
      return DIRECT_READ_REFUSAL;

    return callConnected(parsed.data, ctx.clock, ctx.record);
  }

  if (call.toolName === CODE_RUN_TOOL) {
    const parsed = codeRunInput.safeParse(call.input);

    if (!parsed.success)
      return { status: "invalid_input", toolName: CODE_RUN_TOOL, message: parsed.error.message };

    if (/\bDate\b/.test(parsed.data.source)) ctx.record.scriptReadDate = true;

    const hosts = readHostBindings({
      readTools: READ_TOOLS,
      hostRead: (request) => withCallFacts(request, fakeHostRead(request, ctx.clock, ctx.record)),
      readCatalogRevision: async () => "rev_time_awareness_eval",
    });

    const outcome = await runReadProgram({
      source: parsed.data.source,
      hosts,
      ledger: newHostCallLedger(),
      runId: "run_time_awareness_eval",
    });

    const reads = {
      total: outcome.ledger.length,
      failed: outcome.ledger.filter((entry) => entry.kind !== "executed").length,
    };

    return outcome.status === "completed"
      ? { status: outcome.status, value: outcome.value, reads }
      : { status: outcome.status, message: outcome.message, reads };
  }

  return {
    status: "unknown_tool",
    toolName: call.toolName,
    message: `Unknown tool '${call.toolName}'.`,
  };
}

function systemPrompt(readPath: ChatReadPath, connectedSummary: string): string {
  return buildChatSystemPrompt("", connectedSummary, selfIdentityGrounding(), readPath);
}

const DIRECT_SUMMARY = [
  "You are connected to these integrations right now — call each as integration.action (for example contacts.search), and an MCP server's tools through mcp.call. Treat this list as authoritative: do not offer or attempt an integration that is not on it.",
  `- ${JSON.stringify(CALENDAR_CONNECTION.label)} MCP server (connectionId ${CALENDAR_CONNECTION.id}) — 9 tools; find one with mcp.list_tools scoped to this connectionId, then call it through mcp.call`,
  `- ${JSON.stringify(DRIVE_CONNECTION.label)} MCP server (connectionId ${DRIVE_CONNECTION.id}) — 12 tools; find one with mcp.list_tools scoped to this connectionId, then call it through mcp.call`,
].join("\n");

/** The connected summary of a `code_run` run, as `buildConnectedSummaryFromAvailability` writes it. */
const CODE_RUN_SUMMARY = [
  "You are connected to these integrations right now. Read from them inside system.code_run, where each read tool is an async function with its own name (for example contacts.search) and mcp.read reads an MCP server's tool. Call a write directly as integration.action, and an MCP server's write through mcp.call. Treat this list as authoritative: do not offer or attempt an integration that is not on it. A line marks the calls that wait for the user's approval: each one shows the user an approval card, and that card is the confirmation. Any other call may run at once.",
  `- ${JSON.stringify(CALENDAR_CONNECTION.label)} MCP server (connectionId ${CALENDAR_CONNECTION.id}) — 9 tools; find one with system.search_tools, or with mcp.list_tools inside system.code_run, scoped to this connectionId; read with mcp.read inside the script, and write through mcp.call`,
].join("\n");

/** A user message as chat replays it: the saved time note only when one is due. */
function userMessage(
  text: string,
  timezone: IanaTimezone,
  sentAt: Date,
  previousUserAt?: Date,
): ModelMessage {
  return { role: "user", content: userMessageAt(text, timezone, sentAt, previousUserAt) };
}

/** The morning thread: one note at 09:20, then two messages with no time. */
const MORNING = [ist("09:20"), ist("09:26"), ist("09:32")] as const;

const HISTORY: ModelMessage[] = [
  userMessage(
    "draft a reply to Priya at Northwind about the vendor contract renewal",
    TIMEZONE,
    MORNING[0],
  ),
  {
    role: "assistant",
    content:
      "Here is a draft:\n\nHi Priya, thanks for the renewal terms. We are happy to continue for another year, and we would like to confirm the support hours before we sign. Best, Yash",
  },
  userMessage(
    "make it warmer, and mention the onboarding help last quarter",
    TIMEZONE,
    MORNING[1],
    MORNING[0],
  ),
  {
    role: "assistant",
    content:
      "Updated:\n\nHi Priya, thank you for the renewal terms, and for the onboarding help last quarter — it made a real difference for the team. We are glad to continue for another year. Could you confirm the support hours before we sign? Warm regards, Yash",
  },
  userMessage(
    "good. hold it for now, i want to check the numbers with finance",
    TIMEZONE,
    MORNING[2],
    MORNING[1],
  ),
  { role: "assistant", content: "Sure. The draft is ready when you are." },
];

/** When the answer needs a lookup: never, at any time, or after the slow work of the run. */
type LookupNeed = "none" | "any" | "after_work";

interface Case {
  label: string;
  question: string;
  askedAt: Date;
  readPath: ChatReadPath;
  lookup: LookupNeed;
  expected: TimeAnswerExpectation;
  /** `production`: the run notes of `chat-turn.ts`. `none`: the "model alone" control. */
  runNotes: "production" | "none";
}

const OTHERS_OF = (next: RegExp) =>
  [STANDUP, VENDOR, SAM, DINNER].filter((event) => event !== next);

/** 28 minutes after 09:32: no note, and the standup (09:30-09:45) ended. */
const AFTER_GAP = ist("10:00");

const CASES: Case[] = [
  {
    label: "(a) next, 28 min gap, no note",
    question: "how long until my next meeting?",
    askedAt: AFTER_GAP,
    readPath: "direct",
    runNotes: "production",
    lookup: "any",
    expected: {
      kind: "next",
      next: VENDOR,
      waitMinutes: 240,
      others: OTHERS_OF(VENDOR),
      past: [STANDUP],
    },
  },
  {
    label: "(a) left, 28 min gap, no note",
    question: "what is left on my calendar today?",
    askedAt: AFTER_GAP,
    readPath: "direct",
    runNotes: "production",
    lookup: "any",
    expected: { kind: "left", ahead: [VENDOR, SAM, DINNER], past: [STANDUP] },
  },
  {
    label: "(b) next, hours later, full note",
    question: "how long until my next meeting?",
    askedAt: ist("17:50"),
    readPath: "direct",
    runNotes: "production",
    lookup: "none",
    expected: {
      kind: "next",
      next: SAM,
      waitMinutes: 40,
      others: OTHERS_OF(SAM),
      past: [STANDUP, VENDOR],
    },
  },
  {
    label: "(c) next, 28 min gap, Code Mode",
    question: "how long until my next meeting?",
    askedAt: AFTER_GAP,
    readPath: "code_run",
    runNotes: "production",
    lookup: "any",
    expected: {
      kind: "next",
      next: VENDOR,
      waitMinutes: 240,
      others: OTHERS_OF(VENDOR),
      past: [STANDUP],
    },
  },
  {
    // The note says 13:15. The export takes 40 min, so the answer is from 13:55: 5 min, not 45.
    // Before the step after the export, the run gets the production long-step note.
    label: "(d) next after a 40 min export, full note, long-step note",
    question:
      "export the Q2 vendor spend sheet from drive as a pdf, then tell me how long i have until my next meeting",
    askedAt: ist("13:15"),
    readPath: "direct",
    runNotes: "production",
    lookup: "after_work",
    expected: {
      kind: "next",
      next: VENDOR,
      waitMinutes: 5,
      others: OTHERS_OF(VENDOR),
      past: [STANDUP],
    },
  },
  {
    // The "model alone" control of case (d): no long-step note, so only a clock read gives 13:55.
    label: "(d) control: model alone, no long-step note",
    question:
      "export the Q2 vendor spend sheet from drive as a pdf, then tell me how long i have until my next meeting",
    askedAt: ist("13:15"),
    readPath: "direct",
    runNotes: "none",
    lookup: "after_work",
    expected: {
      kind: "next",
      next: VENDOR,
      waitMinutes: 5,
      others: OTHERS_OF(VENDOR),
      past: [STANDUP],
    },
  },
  {
    label: "(e) control: a start time, no note",
    question: "what time does the vendor review start today?",
    askedAt: AFTER_GAP,
    readPath: "direct",
    runNotes: "production",
    lookup: "none",
    expected: {
      kind: "fact",
      answer:
        /\b14:00\b|\b2(?::00)?\s*(?:(?:–|-|to)\s*3(?::00)?\s*)?(?:pm|p\.m\.)|\b2(?::00)?\s+in the afternoon/i,
    },
  },
];

interface TaskOutput {
  calls: { toolName: string; step: number; at: string }[];
  /** The run notes, with the step that each one came before and the eval clock's time then. */
  notes: { beforeStep: number; at: string; text: string }[];
  clockReads: string[];
  exportedAt: string | null;
  scriptReadDate: boolean;
  steps: number;
  text: string;
}

async function runChat(input: Case): Promise<TaskOutput> {
  if (!CODE_RUN_DESCRIPTION) throw new Error(`${CODE_RUN_TOOL} is not registered`);

  if (!CURRENT_TIME_DESCRIPTION) throw new Error(`${CURRENT_TIME_TOOL} is not registered`);

  const clock: RunClock = { now: input.askedAt };
  const record: RunRecord = { calls: [], clockReads: [], scriptReadDate: false, exportedAt: null };

  const instructions = systemPrompt(
    input.readPath,
    input.readPath === "code_run" ? CODE_RUN_SUMMARY : DIRECT_SUMMARY,
  );

  let messages: ModelMessage[] = [
    ...HISTORY,
    userMessage(input.question, TIMEZONE, input.askedAt, MORNING[2]),
  ];

  let text = "";
  let steps = 0;
  const notes: TaskOutput["notes"] = [];

  // The run state that `takeTimeNote` reads, as `chat-turn.ts` sets it at the first step.
  const noteState: Pick<
    ChatRunState,
    "clockAnchor" | "pausedWait" | "startedAt" | "lastModelStepAt"
  > = { startedAt: input.askedAt.toISOString() };

  while (steps < MAX_STEPS) {
    steps++;
    const tools = stepTools(input.readPath);

    if (input.runNotes === "production") {
      const note = await takeTimeNote(noteState, TIMEZONE, clock.now, async () => input.askedAt);

      if (note) {
        messages = toModelMessages(appendSystemNote(messages, note));
        notes.push({ beforeStep: steps, at: clock.now.toISOString(), text: note });
      }
    }

    const result = await generateText({
      model: route("standard").model(),
      instructions,
      messages,
      tools,
      timeout: { totalMs: EVAL_TIMEOUT_MS },
    });

    text = result.text;
    const calls = result.content.filter((part) => part.type === "tool-call");

    // The SDK writes its own result for a call it cannot parse. Dispatch writes each result, as in
    // `chat-turn.ts`, so drop the SDK's.
    messages.push(...result.responseMessages.filter((message) => message.role !== "tool"));

    if (calls.length === 0) break;

    const ctx: DispatchContext = {
      readPath: input.readPath,
      clock,
      record,
      offered: new Set(Object.keys(tools)),
      step: steps,
    };

    const results = [];

    for (const call of calls) {
      const value = await dispatch(call, ctx);

      results.push({
        type: "tool-result" as const,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "json" as const, value },
      });
    }

    messages.push({ role: "tool", content: results });
  }

  return {
    calls: record.calls,
    notes,
    clockReads: record.clockReads.map((at) => at.toISOString()),
    exportedAt: record.exportedAt?.toISOString() ?? null,
    scriptReadDate: record.scriptReadDate,
    steps,
    text,
  };
}

/**
 * Null when the run had the current time as the case needs. Else the fault. A run note gives the
 * current time as a clock read does (ADR-0130 amendment (f)), so it counts as a lookup.
 */
function lookupFault(input: Case, output: TaskOutput): string | null {
  if (input.lookup === "none") return null;

  const times = [...output.clockReads, ...output.notes.map((note) => note.at)];

  if (times.length === 0) return "did not look up the time and got no run note";

  if (input.lookup === "any") return null;

  if (output.exportedAt === null) return "did not run the export";

  return times.some((at) => at >= (output.exportedAt ?? ""))
    ? null
    : "had the time only before the export";
}

function callSummary(output: TaskOutput): string {
  return `calls=[${output.calls.map((call) => `${call.step}:${call.toolName}`).join(", ") || "none"}]; clock reads=${output.clockReads.length}; notes before steps=[${output.notes.map((note) => note.beforeStep).join(", ")}]; steps=${output.steps}${output.scriptReadDate ? "; a script read Date" : ""}`;
}

evalite<Case, TaskOutput, null>(
  "Agent looks up the time when the answer needs it (ADR-0130 decision 7)",
  {
    data: () => CASES.map((input) => ({ input, expected: null })),
    task: async (input) => {
      serverEnv();

      try {
        return await runChat(input);
      } catch (error) {
        return {
          calls: [],
          notes: [],
          clockReads: [],
          exportedAt: null,
          scriptReadDate: false,
          steps: 0,
          text: `ERROR: ${toMessage(error)}`,
        };
      }
    },
    scorers: [
      {
        name: "The answer is correct",
        scorer: ({ input, output }) => {
          const fault = scoreTimeAnswer(output.text, input.expected);

          return {
            score: fault === null ? 1 : 0,
            metadata: `${input.label}; ${callSummary(output)}${fault === null ? "" : `; ${fault}; replied: ${output.text.slice(0, 300)}`}`,
          };
        },
      },
      {
        // A case whose answer does not need the time always scores 1. Its lookup is a cost metric.
        name: "Looks up the time when the answer needs it",
        scorer: ({ input, output }) => {
          const fault = lookupFault(input, output);

          const cost =
            input.lookup === "none" && output.clockReads.length > 0
              ? "; an extra lookup (cost)"
              : "";

          return {
            score: fault === null ? 1 : 0,
            metadata: `${input.label}; needed=${input.lookup}; clock called=${output.clockReads.length > 0}; run notes=${output.notes.length}${cost}${fault === null ? "" : `; ${fault}`}`,
          };
        },
      },
    ],
  },
);
