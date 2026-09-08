import {
  editStandingInstruction,
  forgetStandingInstruction,
  listStandingInstructions,
  readUserContext as readUserContextFromKnowledge,
  rememberSenderSuppression,
  runWebSearch,
} from "@alfred/assistant/knowledge";
import {
  registerSystemToolKnowledgeAdapter,
  registerSystemToolTaskAdapter,
  type SystemToolKnowledgeAdapter,
  type SystemToolRequest,
  type SystemToolTaskAdapter,
} from "@alfred/assistant/tool-runtime";
import { resolveTodosForGmailSender, suggestTodo } from "@alfred/assistant/tasks";

const SENDER_SUPPRESSION_REASON = "standing_instruction_sender_suppression";

type RememberSenderSuppressionResult = Awaited<ReturnType<typeof rememberSenderSuppression>>;
type ResolveSenderTodosResult = Awaited<ReturnType<typeof resolveTodosForGmailSender>>;
export type RememberAndDismissResult =
  | (Extract<RememberSenderSuppressionResult, { ok: true }> & {
      resolvedTodos: ResolveSenderTodosResult;
    })
  | Extract<RememberSenderSuppressionResult, { ok: false }>;

/**
 * Result of one `system.remember` call that named several senders. Each entry
 * is the same shape a single-sender call returns, so a clarification on one
 * sender never hides the instructions that did persist for the others. `ok` is
 * false only when nothing persisted, so the dispatcher's honesty routing (which
 * reads `ok`/`status`) flags an all-clarification batch as an incomplete action
 * and a partial batch as a success the per-entry results qualify.
 *
 * A literal, not derived: this envelope is minted here and has no schema or row
 * to derive from; the entries inside it are the derived single-sender result.
 */
export interface RememberAndDismissBatchResult {
  ok: boolean;
  status: "batch";
  results: Array<{ senderEmail: string; result: RememberAndDismissResult }>;
  rememberedCount: number;
  clarificationCount: number;
}

interface SenderSuppressionDependencies {
  remember: typeof rememberSenderSuppression;
  dismissTodos: typeof resolveTodosForGmailSender;
}

type RememberRequest = SystemToolRequest<"system.remember">;
type RememberInput = RememberRequest["input"];
/** One sender to remember: the single-sender fields of the tool input. */
type SenderEntry = Pick<RememberInput, "senderEmail" | "senderLabel">;
/** One entry of the batch form; its email is always present. */
type BatchSenderEntry = NonNullable<RememberInput["senders"]>[number];

/**
 * Persist one sender suppression and dismiss its live todos. The
 * standing-instruction write lands first so a todo is never dismissed for a
 * sender Alfred did not actually remember.
 */
async function rememberOneSender(
  dependencies: SenderSuppressionDependencies,
  { input, context }: RememberRequest,
  sender: SenderEntry,
): Promise<RememberAndDismissResult> {
  const result = await dependencies.remember({
    userId: context.userId,
    senderEmail: sender.senderEmail,
    senderLabel: sender.senderLabel,
    accountId: input.accountId ?? null,
    directive: input.directive,
    phrasing: input.phrasing,
    source: {
      kind: "tool_call",
      id: context.toolCallId,
      meta: { runId: context.runId, stepId: context.stepId },
    },
  });
  if (!result.ok) return result;

  const resolvedTodos = await dependencies.dismissTodos({
    userId: context.userId,
    senderEmail: result.instruction.target.email,
    accountId: result.instruction.target.accountId,
    reason: SENDER_SUPPRESSION_REASON,
  });
  return { ...result, resolvedTodos };
}

/**
 * A call without `senders` keeps the single-sender result shape exactly. A
 * call with `senders` runs the same remember-then-dismiss sequence once per
 * entry, in order, and reports every outcome: one model step covers a whole
 * "apply this to all of them" ask instead of one step per sender (prod
 * `run_tsevusjk1poq` spent thirteen of its twenty-four steps that way). A
 * top-level `senderEmail` given alongside `senders` is one more entry, and a
 * sender named twice is remembered once.
 */
export function createRememberSenderSuppressionCoordinator(
  dependencies: SenderSuppressionDependencies,
): (args: RememberRequest) => Promise<RememberAndDismissResult | RememberAndDismissBatchResult> {
  return async (args) => {
    const { input } = args;
    if (!input.senders) {
      return rememberOneSender(dependencies, args, {
        senderEmail: input.senderEmail,
        senderLabel: input.senderLabel,
      });
    }

    const seen = new Set<string>();
    const entries: BatchSenderEntry[] = [];
    const candidates: BatchSenderEntry[] = input.senderEmail
      ? [{ senderEmail: input.senderEmail, senderLabel: input.senderLabel }, ...input.senders]
      : input.senders;
    for (const entry of candidates) {
      if (seen.has(entry.senderEmail)) continue;
      seen.add(entry.senderEmail);
      entries.push(entry);
    }

    const results: RememberAndDismissBatchResult["results"] = [];
    for (const entry of entries) {
      const result = await rememberOneSender(dependencies, args, entry);
      results.push({ senderEmail: entry.senderEmail, result });
    }
    const rememberedCount = results.filter(({ result }) => result.ok).length;
    return {
      ok: rememberedCount > 0,
      status: "batch",
      results,
      rememberedCount,
      clarificationCount: results.length - rememberedCount,
    };
  };
}

export const rememberSenderSuppressionAndDismissTodos = createRememberSenderSuppressionCoordinator({
  remember: rememberSenderSuppression,
  dismissTodos: resolveTodosForGmailSender,
});

const knowledgeAdapter: SystemToolKnowledgeAdapter = {
  readUserContext({ input, context }) {
    return readUserContextFromKnowledge(context.userId, {
      subjectEmail: input.subjectEmail,
      query: input.query,
      include: input.include,
    });
  },
  rememberSenderSuppressionAndDismissTodos,
  listInstructions({ context }) {
    return listStandingInstructions(context.userId);
  },
  forgetInstruction({ input, context }) {
    return forgetStandingInstruction({
      userId: context.userId,
      factId: input.factId,
      reason: input.reason,
      source: {
        kind: "tool_call",
        id: context.toolCallId,
        meta: { runId: context.runId, stepId: context.stepId },
      },
    });
  },
  editInstruction({ input, context }) {
    return editStandingInstruction({
      userId: context.userId,
      factId: input.factId,
      directive: input.directive,
      senderLabel: input.senderLabel,
      source: {
        kind: "tool_call",
        id: context.toolCallId,
        meta: { runId: context.runId, stepId: context.stepId },
      },
    });
  },
  async webSearch({ input, context }) {
    const { answer, citations, results, searchQueries } = await runWebSearch({
      query: input.query,
      userId: context.userId,
      runId: context.runId,
      stepId: context.stepId,
      idempotencyKey: context.toolCallId,
    });
    return { ok: true, query: input.query, answer, citations, results, searchQueries };
  },
};

const taskAdapter: SystemToolTaskAdapter = {
  resolveTodo({ input, context }) {
    return resolveTodosForGmailSender({
      userId: context.userId,
      senderEmail: input.senderEmail,
      sourceThreadId: input.sourceThreadId,
      accountId: input.accountId ?? null,
      reason: input.reason,
    });
  },
  suggestTodo({ input, context }) {
    return suggestTodo({
      userId: context.userId,
      agentRunId: context.runId,
      name: input.name,
      description: input.description,
      assist: input.assist,
      sources: input.sources,
    });
  },
};

let unregisterKnowledge: (() => void) | undefined;
let unregisterTasks: (() => void) | undefined;

export function registerSystemToolProductAdapters(): void {
  unregisterKnowledge ??= registerSystemToolKnowledgeAdapter(knowledgeAdapter);
  unregisterTasks ??= registerSystemToolTaskAdapter(taskAdapter);
}

export function unregisterSystemToolProductAdapters(): void {
  unregisterTasks?.();
  unregisterTasks = undefined;
  unregisterKnowledge?.();
  unregisterKnowledge = undefined;
}
