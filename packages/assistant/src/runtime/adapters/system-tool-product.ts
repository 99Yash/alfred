import { toMessage } from "@alfred/contracts";
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
 * One sender's outcome inside a batch: the single-sender result, or the error a
 * throw mid-batch produced for that sender alone. A throw in entry seven of
 * thirteen must not fail the whole call, because entries one to six already
 * persisted; the honesty guard would then tell the model to report a failure
 * for work that happened.
 */
export type RememberBatchEntryResult =
  | RememberAndDismissResult
  | { ok: false; status: "failed"; message: string };

/**
 * Result of one `system.remember` call that named several senders. Each entry
 * is the same shape a single-sender call returns, so a clarification or an
 * error on one sender never hides the instructions that did persist for the
 * others. `ok` is false only when nothing persisted, so the dispatcher's
 * honesty routing (which reads `ok`/`status`) flags an all-miss batch as an
 * incomplete action and a partial batch as a success the per-entry results
 * qualify. The envelope is `ok: boolean` with counts, not a discriminated union:
 * the honesty routing sees one verdict per call, and a twelve-of-thirteen batch
 * routes as a success whose one miss only the per-entry results show.
 *
 * A literal, not derived: this envelope is minted here and has no schema or row
 * to derive from; the entries inside it are the derived single-sender result.
 */
export interface RememberAndDismissBatchResult {
  ok: boolean;
  status: "batch";
  results: Array<{ senderEmail: string; result: RememberBatchEntryResult }>;
  rememberedCount: number;
  clarificationCount: number;
  failedCount: number;
}

interface SenderSuppressionDependencies {
  remember: typeof rememberSenderSuppression;
  dismissTodos: typeof resolveTodosForGmailSender;
}

type RememberRequest = SystemToolRequest<"system.remember">;
type RememberInput = RememberRequest["input"];
/**
 * One sender to remember: the single-sender fields of the tool input. A
 * `senders[]` entry is the same pair with the email required, so it is
 * assignable here without a second name.
 */
type SenderEntry = Pick<RememberInput, "senderEmail" | "senderLabel">;

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

    // Keyed by email so a sender named twice (or once at the top level and
    // once in the array) is remembered once; the first spelling's label wins.
    const entries = new Map<string, SenderEntry>();
    if (input.senderEmail) {
      entries.set(input.senderEmail, {
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
    const rememberedCount = results.filter(({ result }) => result.ok).length;
    const failedCount = results.filter(({ result }) => result.status === "failed").length;
    return {
      ok: rememberedCount > 0,
      status: "batch",
      results,
      rememberedCount,
      clarificationCount: results.length - rememberedCount - failedCount,
      failedCount,
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
