import { toMessage, type TodoSource } from "@alfred/contracts";
import {
  editStandingInstruction,
  forgetStandingInstruction,
  listStandingInstructions,
  readUserContext as readUserContextFromKnowledge,
  rememberSenderSuppression,
  runWebSearch,
} from "@alfred/assistant/knowledge";
import { readGmailThreadClosure } from "@alfred/assistant/triage";
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
import { resolveTodosForGmailSource, suggestTodo } from "@alfred/assistant/tasks";
import { gmailThreadIdsFromSources } from "@alfred/assistant/tasks/resolve";

const SENDER_SUPPRESSION_REASON = "standing_instruction_sender_suppression";

type RememberSenderSuppressionResult = Awaited<ReturnType<typeof rememberSenderSuppression>>;

type ResolveSenderTodosResult = Awaited<ReturnType<typeof resolveTodosForGmailSource>>;

export type RememberAndDismissResult =
  | (Extract<RememberSenderSuppressionResult, { ok: true }> & {
      resolvedTodos: ResolveSenderTodosResult;
    })
  | Extract<RememberSenderSuppressionResult, { ok: false }>;

/**
 * One sender's batch outcome. A throw fails only that sender, because earlier
 * senders already persisted. The exported name lives in `tool-runtime/index.ts`.
 */
type RememberBatchEntryResult =
  | RememberAndDismissResult
  | { ok: false; status: "failed"; message: string };

/**
 * Result of a multi-sender `system.remember`. `ok` is false only when nothing
 * persisted, so the dispatcher treats a partial batch as success; the entries
 * show the misses.
 */
export interface RememberAndDismissBatchResult {
  ok: boolean;
  status: "batch";
  results: Array<{ senderEmail: string; result: RememberBatchEntryResult }>;
  /** Distinct `factId`s: instruction rows, not senders. */
  rememberedCount: number;
  /** Entries, not rows. */
  clarificationCount: number;
  failedCount: number;
}

interface SenderSuppressionDependencies {
  remember: typeof rememberSenderSuppression;
  dismissTodos: typeof resolveTodosForGmailSource;
}

type RememberRequest = SystemToolRequest<"system.remember">;

type RememberInput = RememberRequest["input"];

/** Per-entry `scope` overrides the top-level one, like `accountId`. */
type SenderEntry = Pick<RememberInput, "senderEmail" | "senderLabel" | "scope">;

/** Remember first, so no todo is dismissed for a sender Alfred did not remember. */
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
    scope: sender.scope ?? input.scope,
    source: {
      kind: "tool_call",
      id: context.toolCallId,
      meta: { runId: context.runId, stepId: context.stepId },
    },
  });

  if (!result.ok) return result;

  const resolvedTodos = await dependencies.dismissTodos({
    userId: context.userId,
    // The whole target, such as every sender at a domain. It already carries `accountId`.
    target: result.instruction.target,
    reason: SENDER_SUPPRESSION_REASON,
    // `agent`: not a direct UI clear (`user`) and not an automatic retraction (`system`).
    actor: "agent",
  });

  return { ...result, resolvedTodos };
}

/**
 * Without `senders`, the single-sender shape. With `senders`, one
 * remember-then-dismiss per entry in one model step, so a long list does not
 * use one step per sender. A duplicate sender is remembered once.
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
        scope: input.scope,
      });
    }

    // Keyed by email; the first spelling's label wins.
    const entries = new Map<string, SenderEntry>();

    if (input.senderEmail) {
      entries.set(input.senderEmail, {
        scope: input.scope,
        senderEmail: input.senderEmail,
        senderLabel: input.senderLabel,
      });
    }

    for (const entry of input.senders) {
      if (!entries.has(entry.senderEmail)) entries.set(entry.senderEmail, entry);
    }

    const results: RememberAndDismissBatchResult["results"] = [];

    for (const [senderEmail, entry] of entries) {
      try {
        results.push({ senderEmail, result: await rememberOneSender(dependencies, args, entry) });
      } catch (error) {
        results.push({
          senderEmail,
          result: { ok: false, status: "failed", message: toMessage(error) },
        });
      }
    }

    // Count distinct rows: entries that collapse onto one domain instruction count once.
    // `already_exists` carries a `factId` too, so a full collapse still reports `ok`.
    const okEntryCount = results.filter(({ result }) => result.ok).length;

    const rememberedCount = new Set(
      results.flatMap(({ result }) => (result.ok ? [result.factId] : [])),
    ).size;

    const failedCount = results.filter(({ result }) => result.status === "failed").length;

    return {
      ok: rememberedCount > 0,
      status: "batch",
      results,
      rememberedCount,
      // Entries, not rows.
      clarificationCount: results.length - okEntryCount - failedCount,
      failedCount,
    };
  };
}

export const rememberSenderSuppressionAndDismissTodos = createRememberSenderSuppressionCoordinator({
  remember: rememberSenderSuppression,
  dismissTodos: resolveTodosForGmailSource,
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
};

const webSearchAdapter: SystemToolWebSearchAdapter = {
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
  resolveTodo({ input, context }) {
    return resolveTodosForGmailSource({
      userId: context.userId,
      senderEmail: input.senderEmail,
      sourceThreadId: input.sourceThreadId,
      accountId: input.accountId ?? null,
      reason: input.reason,
      actor: "agent",
    });
  },
  async suggestTodo({ input, context }) {
    const answered = await gmailSourcesAlreadyAnswered(context.userId, input.sources ?? []).catch(
      () => false,
    );

    if (answered) {
      return { ok: true, status: "suppressed", reason: "user_already_replied" };
    }

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
