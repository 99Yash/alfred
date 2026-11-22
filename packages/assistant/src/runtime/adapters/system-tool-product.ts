import { isQuotaOrBillingError } from "@alfred/ai";
import type { TodoAttribution, TodoSource } from "@alfred/contracts";
import { AppError } from "@alfred/contracts/app-errors";
import { logger } from "@alfred/logging";
import {
  checkStandingInstructionCapture,
  editStandingInstruction,
  forgetStandingInstruction,
  listStandingInstructions,
  readUserContextItems,
  runWebSearch,
  saveStandingInstruction,
} from "@alfred/assistant/knowledge";
import { readGmailThreadClosure } from "@alfred/assistant/triage";
import {
  itemEvidence,
  readResult,
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

/**
 * `resolvedTodos` is always null since triage slice 4a: no instruction blocks a todo in code, so
 * capture sweeps no todo. The key stays, so the `system.remember` result keeps its shape.
 */
type RememberAndDismissResult =
  | (Extract<SaveInstructionResult, { ok: true }> & { resolvedTodos: null })
  | Extract<SaveInstructionResult, { ok: false }>;

type RememberRequest = SystemToolRequest<"system.remember">;

/** Save the instruction (ADR-0113 capture). Slice 4b rewrites the save path to words. */
async function rememberInstructionAndDismissTodos({
  input,
  context,
}: RememberRequest): Promise<RememberAndDismissResult> {
  const { kind: _kind, ...fields } = input;

  const result = await saveStandingInstruction({
    userId: context.userId,
    input: fields,
    source: {
      kind: "tool_call",
      id: context.toolCallId,
      meta: { runId: context.runId, stepId: context.stepId },
    },
  });

  if (!result.ok) return result;

  return { ...result, resolvedTodos: null };
}

const knowledgeAdapter: SystemToolKnowledgeAdapter = {
  async readUserContext({ input, context }) {
    const read = await readUserContextItems(context.userId, {
      subjectEmail: input.subjectEmail,
      query: input.query,
      include: input.include,
    });

    // Each delivered row by its id, for the evidence record of a script read (ADR-0124).
    return readResult(
      read.context,
      itemEvidence(
        read.items.map(({ store, id, depth, version, item }) => ({
          ref: { kind: "record", store, id, depth, ...(version ? { version } : {}) },
          item,
        })),
      ),
    );
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
