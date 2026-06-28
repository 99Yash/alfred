const DEV =
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true &&
  typeof window !== "undefined" &&
  typeof performance !== "undefined";

type RepeatMode = "ignore" | "update";

interface ChatTimingMark {
  stage: string;
  at: number;
  iso: string;
  detail?: Record<string, unknown>;
}

interface ChatTurnTiming {
  clientTurnId: string;
  threadId: string;
  userMessageId?: string;
  assistantMessageId?: string;
  runId?: string | null;
  contentChars?: number;
  marks: Map<string, ChatTimingMark>;
}

interface MarkOptions {
  log?: boolean;
  repeat?: RepeatMode;
  summarize?: boolean;
  requireExisting?: boolean;
}

const byUserMessageId = new Map<string, ChatTurnTiming>();
const byAssistantMessageId = new Map<string, ChatTurnTiming>();
const order: ChatTurnTiming[] = [];
const MAX_TURNS = 30;

export function markChatSubmit(args: {
  threadId: string;
  userMessageId: string;
  contentChars: number;
}): void {
  if (!DEV) return;
  const turn = {
    clientTurnId: args.userMessageId,
    threadId: args.threadId,
    userMessageId: args.userMessageId,
    contentChars: args.contentChars,
    marks: new Map<string, ChatTimingMark>(),
  };
  byUserMessageId.set(args.userMessageId, turn);
  order.push(turn);
  trimOldTurns();
  mark(turn, "submit", { contentChars: args.contentChars });
}

export function markChatTimingByUser(
  userMessageId: string,
  stage: string,
  detail?: Record<string, unknown>,
  options?: MarkOptions,
): void {
  if (!DEV) return;
  const turn = byUserMessageId.get(userMessageId);
  if (!turn) return;
  mark(turn, stage, detail, options);
}

export function attachChatAssistantTiming(args: {
  userMessageId: string;
  assistantMessageId: string;
  runId: string | null;
  detail?: Record<string, unknown>;
}): void {
  if (!DEV) return;
  const userTurn = byUserMessageId.get(args.userMessageId);
  const assistantTurn = byAssistantMessageId.get(args.assistantMessageId);
  const turn = mergeTurns(userTurn, assistantTurn) ?? userTurn ?? assistantTurn;
  if (!turn) return;

  turn.assistantMessageId = args.assistantMessageId;
  turn.runId = args.runId;
  byUserMessageId.set(args.userMessageId, turn);
  byAssistantMessageId.set(args.assistantMessageId, turn);
  mark(turn, "turn_request_ack", {
    runId: args.runId,
    assistantMessageId: args.assistantMessageId,
    ...args.detail,
  });
}

export function markChatTimingByAssistant(
  assistantMessageId: string,
  stage: string,
  detail?: Record<string, unknown>,
  options?: MarkOptions & { threadId?: string; runId?: string },
): void {
  if (!DEV) return;
  let turn = byAssistantMessageId.get(assistantMessageId);
  if (!turn) {
    if (options?.requireExisting) return;
    turn = {
      clientTurnId: assistantMessageId,
      threadId: options?.threadId ?? "unknown",
      assistantMessageId,
      runId: options?.runId,
      marks: new Map<string, ChatTimingMark>(),
    };
    byAssistantMessageId.set(assistantMessageId, turn);
    order.push(turn);
    trimOldTurns();
  }
  if (options?.threadId && turn.threadId === "unknown") turn.threadId = options.threadId;
  if (options?.runId && !turn.runId) turn.runId = options.runId;
  mark(turn, stage, detail, options);
}

export function getChatTimingSnapshot(): Array<{
  threadId: string;
  userMessageId?: string;
  assistantMessageId?: string;
  runId?: string | null;
  timeline: Array<Record<string, unknown>>;
}> {
  return order.map((turn) => ({
    threadId: turn.threadId,
    userMessageId: turn.userMessageId,
    assistantMessageId: turn.assistantMessageId,
    runId: turn.runId,
    timeline: timelineRows(turn),
  }));
}

function mergeTurns(
  userTurn: ChatTurnTiming | undefined,
  assistantTurn: ChatTurnTiming | undefined,
): ChatTurnTiming | undefined {
  if (!userTurn || !assistantTurn || userTurn === assistantTurn) return userTurn ?? assistantTurn;
  for (const [stage, assistantMark] of assistantTurn.marks) {
    if (!userTurn.marks.has(stage)) userTurn.marks.set(stage, assistantMark);
  }
  byAssistantMessageId.set(
    assistantTurn.assistantMessageId ?? assistantTurn.clientTurnId,
    userTurn,
  );
  return userTurn;
}

function mark(
  turn: ChatTurnTiming,
  stage: string,
  detail?: Record<string, unknown>,
  options?: MarkOptions,
): void {
  const existing = turn.marks.get(stage);
  const repeat = options?.repeat ?? "ignore";
  if (existing && repeat === "ignore") return;

  const at = performance.now();
  const next: ChatTimingMark = {
    stage,
    at,
    iso: new Date().toISOString(),
    detail,
  };
  turn.marks.set(stage, next);

  if (options?.log !== false) {
    const submit = turn.marks.get("submit");
    const previous = previousMark(turn, stage, at);
    console.info(`[chat timing] ${stage}`, {
      sinceSubmitMs: submit ? round(at - submit.at) : null,
      sincePreviousMs: previous ? round(at - previous.at) : null,
      threadId: turn.threadId,
      userMessageId: turn.userMessageId,
      assistantMessageId: turn.assistantMessageId,
      runId: turn.runId,
      ...detail,
    });
  }

  if (options?.summarize) printSummary(turn, stage);
  exposeDebugHandle();
}

function previousMark(
  turn: ChatTurnTiming,
  currentStage: string,
  currentAt: number,
): ChatTimingMark | null {
  let previous: ChatTimingMark | null = null;
  for (const mark of turn.marks.values()) {
    if (mark.stage === currentStage || mark.at > currentAt) continue;
    if (!previous || mark.at > previous.at) previous = mark;
  }
  return previous;
}

function printSummary(turn: ChatTurnTiming, stage: string): void {
  const label = turn.assistantMessageId ?? turn.userMessageId ?? turn.clientTurnId;
  console.groupCollapsed(`[chat timing] summary after ${stage}: ${label}`);
  console.table(timelineRows(turn));
  console.info({
    threadId: turn.threadId,
    userMessageId: turn.userMessageId,
    assistantMessageId: turn.assistantMessageId,
    runId: turn.runId,
    contentChars: turn.contentChars,
  });
  console.groupEnd();
}

function timelineRows(turn: ChatTurnTiming): Array<Record<string, unknown>> {
  const rows = Array.from(turn.marks.values()).toSorted((a, b) => a.at - b.at);
  const submitAt = turn.marks.get("submit")?.at ?? rows[0]?.at ?? 0;
  return rows.map((row, index) => {
    const previous = rows[index - 1];
    return {
      stage: row.stage,
      sinceSubmitMs: round(row.at - submitAt),
      sincePreviousMs: previous ? round(row.at - previous.at) : 0,
      at: row.iso,
      ...row.detail,
    };
  });
}

function trimOldTurns(): void {
  while (order.length > MAX_TURNS) {
    const removed = order.shift();
    if (!removed) continue;
    if (removed.userMessageId) byUserMessageId.delete(removed.userMessageId);
    if (removed.assistantMessageId) byAssistantMessageId.delete(removed.assistantMessageId);
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function exposeDebugHandle(): void {
  (
    globalThis as { __alfredChatTimings?: () => ReturnType<typeof getChatTimingSnapshot> }
  ).__alfredChatTimings = getChatTimingSnapshot;
}
