import { isQuotaOrBillingError } from "@alfred/ai";
import type { TodoAttribution, TodoSource } from "@alfred/contracts";
import { AppError } from "@alfred/contracts/app-errors";
import { logger } from "@alfred/logging";
import {
  checkStandingInstructionCapture,
  editStandingInstruction,
  forgetStandingInstruction,
  listStandingInstructions,
  readUserContext as readUserContextFromKnowledge,
  runWebSearch,
  saveStandingInstruction,
} from "@alfred/assistant/knowledge";
import {
  readGmailThreadClosure,
  threadsWhereInstructionBlocksTodo,
} from "@alfred/assistant/triage";
import {
  registerSystemToolInstructionAdapter,
  registerSystemToolKnowledgeAdapter,
  registerSystemToolTaskAdapter,
  registerSystemToolWebSearchAdapter,
  type SystemToolInstructionAdapter,
  type SystemToolKnowledgeAdapter,
  type SystemToolRequest,
  type SystemToolTaskAdapter,
  type SystemToolWebSearchAdapter,
} from "@alfred/assistant/tool-runtime";
import {
  listTodos,
  resolveTodosByIds,
  resolveTodosForGmailSource,
  suggestTodo,
} from "@alfred/assistant/tasks";
import { gmailThreadIdsFromSources } from "@alfred/assistant/tasks/resolve";

type ToolCallContext = SystemToolRequest<"system.resolve_todo">["context"];

/**
 * A todo write from a chat tool call. Dispatch does not pass the user message yet, so the
 * authority is not recorded; #1588 checks it at dispatch and fills it.
 */
function chatToolAttribution(
  context: ToolCallContext,
  cause: TodoAttribution["cause"],
  note: string | null = null,
): Extract<TodoAttribution, { actor: "agent" }> {
  return {
    actor: "agent",
    runId: context.runId,
    toolCallId: context.toolCallId,
    authority: null,
    authorityRef: null,
    cause,
    note,
  };
}

type SaveInstructionResult = Awaited<ReturnType<typeof saveStandingInstruction>>;

type ResolveSenderTodosResult = Awaited<ReturnType<typeof resolveTodosForGmailSource>>;

/**
 * The todo sweep after the write. `null`: the instruction blocks no todo, or names no sender.
 * `sweep_failed`: the instruction is stored, and no todo was dismissed.
 */
type InstructionTodoSweepResult =
  | ResolveSenderTodosResult
  | { ok: false; status: "sweep_failed"; message: string }
  | null;

export type RememberAndDismissResult =
  | (Extract<SaveInstructionResult, { ok: true }> & {
      resolvedTodos: InstructionTodoSweepResult;
    })
  | Extract<SaveInstructionResult, { ok: false }>;

interface InstructionCaptureDependencies {
  save: typeof saveStandingInstruction;
  dismissTodos: typeof resolveTodosForGmailSource;
  admitThreads: typeof threadsWhereInstructionBlocksTodo;
}

type RememberRequest = SystemToolRequest<"system.remember">;

/**
 * Save first, so no todo is dismissed for an instruction Alfred did not store. When the
 * instruction blocks todo suggestions, the live todos of the senders it names are dismissed in
 * one write, but only where the effective triage result blocks the todo now. So an exception
 * that cancels the block keeps its todo. A scope reaches no live todo here: it matches only in
 * triage. A failed sweep keeps the stored instruction and says so; the same call again
 * returns `already_exists` and sweeps again.
 */
export function createRememberInstructionCoordinator(
  dependencies: InstructionCaptureDependencies,
): (args: RememberRequest) => Promise<RememberAndDismissResult> {
  return async ({ input, context }) => {
    const { kind: _kind, ...fields } = input;

    const result = await dependencies.save({
      userId: context.userId,
      input: fields,
      source: {
        kind: "tool_call",
        id: context.toolCallId,
        meta: { runId: context.runId, stepId: context.stepId },
      },
    });

    if (!result.ok) return result;

    const [firstTarget, ...otherTargets] = result.instruction.targets;

    const blocksTodos = result.instruction.effects.some(
      (effect) => effect.kind === "block_todo_suggestion",
    );

    if (!blocksTodos || firstTarget === undefined) return { ...result, resolvedTodos: null };

    const resolvedTodos = await dependencies
      .dismissTodos(
        { userId: context.userId, targets: [firstTarget, ...otherTargets] },
        // The instruction just stored permits the sweep, so it is the authority.
        {
          actor: "agent",
          runId: context.runId,
          toolCallId: context.toolCallId,
          authority: "instruction",
          authorityRef: { kind: "instruction", id: result.factId },
          cause: "sender_suppressed",
        },
        {
          admitThreads: (sourceThreadIds) =>
            dependencies.admitThreads({
              userId: context.userId,
              instructionId: result.instruction.instructionId,
              sourceThreadIds,
            }),
        },
      )
      .catch((err: unknown): InstructionTodoSweepResult => {
        logger.warn(
          { err },
          `[standing-instructions] todo sweep failed instruction=${result.instruction.instructionId}`,
        );

        return {
          ok: false,
          status: "sweep_failed",
          message:
            "The instruction is stored, but no existing todo was dismissed. Call " +
            "system.remember again with the same input to retry the sweep.",
        };
      });

    return { ...result, resolvedTodos };
  };
}

export const rememberInstructionAndDismissTodos = createRememberInstructionCoordinator({
  save: saveStandingInstruction,
  dismissTodos: resolveTodosForGmailSource,
  admitThreads: threadsWhereInstructionBlocksTodo,
});

const knowledgeAdapter: SystemToolKnowledgeAdapter = {
  readUserContext({ input, context }) {
    return readUserContextFromKnowledge(context.userId, {
      subjectEmail: input.subjectEmail,
      query: input.query,
      include: input.include,
    });
  },
};

const instructionAdapter: SystemToolInstructionAdapter = {
  rememberInstructionAndDismissTodos,
  checkInstruction({ input, context }) {
    const { kind: _kind, ...fields } = input;

    return checkStandingInstructionCapture({ userId: context.userId, input: fields });
  },
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
};

const webSearchAdapter: SystemToolWebSearchAdapter = {
  async webSearch({ input, context }) {
    // The SDK already retried. A money fault does not refill, so the generic "retry" fix only buys a second failure.
    const { answer, citations, results, searchQueries } = await runWebSearch({
      query: input.query,
      userId: context.userId,
      runId: context.runId,
      stepId: context.stepId,
      idempotencyKey: context.toolCallId,
    }).catch((err: unknown) => {
      if (isQuotaOrBillingError(err)) {
        throw new AppError("web_search_quota_exhausted", { cause: err });
      }

      throw err;
    });

    return { ok: true, query: input.query, answer, citations, results, searchQueries };
  },
};

/**
 * Do not suggest a todo for a Gmail thread the user already answered.
 * `readGmailThreadClosure` owns that rule. A DB error mints the todo anyway.
 */
async function gmailSourcesAlreadyAnswered(
  userId: string,
  sources: readonly TodoSource[],
): Promise<boolean> {
  for (const sourceThreadId of gmailThreadIdsFromSources(sources)) {
    const closure = await readGmailThreadClosure({ userId, sourceThreadId });

    if (closure.userHasReplied) return true;
  }

  return false;
}

const taskAdapter: SystemToolTaskAdapter = {
  listTodos({ input, context }) {
    return listTodos({ userId: context.userId, status: input.status, limit: input.limit });
  },
  resolveTodo({ input, context }) {
    const attribution = chatToolAttribution(context, "dismissed", input.reason ?? null);

    if (input.kind === "todo_ids") {
      // The input schema requires `todoIds` for this kind. An empty list fails the task parse.
      return resolveTodosByIds(
        { userId: context.userId, todoIds: input.todoIds ?? [] },
        attribution,
      );
    }

    return resolveTodosForGmailSource(
      {
        userId: context.userId,
        senderEmail: input.senderEmail,
        sourceThreadId: input.sourceThreadId,
        accountId: input.accountId ?? null,
      },
      attribution,
    );
  },
  async suggestTodo({ input, context }) {
    const answered = await gmailSourcesAlreadyAnswered(context.userId, input.sources ?? []).catch(
      (err: unknown) => {
        // A failed check does not suppress the suggestion.
        logger.warn({ err }, "[suggest-todo] already-answered check failed");

        return false;
      },
    );

    if (answered) {
      return { ok: true, status: "suppressed", reason: "user_already_replied" };
    }

    return suggestTodo({
      userId: context.userId,
      attribution: chatToolAttribution(context, "suggested"),
      name: input.name,
      description: input.description,
      assist: input.assist,
      sources: input.sources,
    });
  },
};

let unregisterKnowledge: (() => void) | undefined;

let unregisterInstructions: (() => void) | undefined;

let unregisterWebSearch: (() => void) | undefined;

let unregisterTasks: (() => void) | undefined;

export function registerSystemToolProductAdapters(): void {
  unregisterKnowledge ??= registerSystemToolKnowledgeAdapter(knowledgeAdapter);
  unregisterInstructions ??= registerSystemToolInstructionAdapter(instructionAdapter);
  unregisterWebSearch ??= registerSystemToolWebSearchAdapter(webSearchAdapter);
  unregisterTasks ??= registerSystemToolTaskAdapter(taskAdapter);
}

export function unregisterSystemToolProductAdapters(): void {
  unregisterTasks?.();
  unregisterTasks = undefined;
  unregisterWebSearch?.();
  unregisterWebSearch = undefined;
  unregisterInstructions?.();
  unregisterInstructions = undefined;
  unregisterKnowledge?.();
  unregisterKnowledge = undefined;
}
