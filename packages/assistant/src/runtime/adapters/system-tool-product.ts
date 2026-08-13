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

interface SenderSuppressionDependencies {
  remember: typeof rememberSenderSuppression;
  dismissTodos: typeof resolveTodosForGmailSender;
}

export function createRememberSenderSuppressionCoordinator(
  dependencies: SenderSuppressionDependencies,
): (args: SystemToolRequest<"system.remember">) => Promise<RememberAndDismissResult> {
  return async (args) => {
    const { input, context } = args;
    const result = await dependencies.remember({
      userId: context.userId,
      senderEmail: input.senderEmail,
      senderLabel: input.senderLabel,
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
