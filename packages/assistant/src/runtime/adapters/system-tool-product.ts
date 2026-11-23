import { isQuotaOrBillingError } from "@alfred/ai";
import type { TodoAttribution, TodoSource, UserClaimProvenance } from "@alfred/contracts";
import { AppError } from "@alfred/contracts/app-errors";
import { logger } from "@alfred/logging";
import {
  checkStandingInstructionCapture,
  claimProducer,
  editStandingInstruction,
  findUserWordsInThread,
  forgetStandingInstruction,
  listStandingInstructions,
  readUserContextItems,
  readUserTurnOfRun,
  runWebSearch,
  saveStandingInstruction,
  userApprovedStaging,
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

type RememberRequest = SystemToolRequest<"system.remember">;

/** The refusal when no user chat turn of this thread started the run: an instruction is the user's claim. */
const NOT_SAID_IN_CHAT = {
  ok: false,
  status: "not_said_in_chat",
  message:
    "Only a chat message from the user can make or change an instruction. No user chat message started this run, so nothing changed.",
} as const;

/** What the instruction write changes: the words that readers read, and the senders it names. */
interface InstructionChange {
  words: string | undefined;
  names: readonly string[];
}

/**
 * The provenance of an instruction write (ADR-0123, ADR-0115 rule 1). The user's turn that
 * started the run must be in the thread of the call. Then one of two proofs makes the write the
 * user's own claim:
 *  - the words are the user's own words in a user turn of the thread (no card ran), or
 *  - the user approved the card of this exact call (`tool_approval`).
 * Null when neither holds. The tool is `high` without the first proof, so the second one is the
 * normal path then; null fails closed.
 */
async function instructionProvenance(
  context: ToolCallContext,
  pipeline: string,
  change: InstructionChange,
): Promise<UserClaimProvenance | null> {
  if (context.threadId === undefined) return null;

  const turnId = await readUserTurnOfRun(context.userId, context.runId, context.threadId);

  if (turnId === null) return null;

  const producer = claimProducer({ pipeline, runId: context.runId, model: context.modelId });

  const wordsTurnId =
    change.words === undefined
      ? null
      : await findUserWordsInThread({
          userId: context.userId,
          threadId: context.threadId,
          words: change.words,
          names: change.names,
        });

  if (wordsTurnId !== null) {
    return { author: "user", evidence: [{ kind: "chat_message", id: wordsTurnId }], producer };
  }

  if (
    context.stagingId !== undefined &&
    (await userApprovedStaging(context.userId, context.stagingId))
  ) {
    return {
      author: "user",
      evidence: [
        { kind: "chat_message", id: turnId },
        { kind: "tool_approval", stagingId: context.stagingId },
      ],
      producer,
    };
  }

  return null;
}

/**
 * Save the instruction (ADR-0113 capture). It changes no todo: no instruction blocks a todo in
 * code since triage slice 4a. Slice 4b rewrites the save path to words.
 */
async function rememberStandingInstruction({ input, context }: RememberRequest) {
  const { kind: _kind, ...fields } = input;

  const provenance = await instructionProvenance(context, "system.remember", {
    words: input.phrasing,
    names: [...(input.targets ?? []), ...(input.senderFilter ?? [])],
  });

  if (provenance === null) return NOT_SAID_IN_CHAT;

  return saveStandingInstruction({
    userId: context.userId,
    input: fields,
    provenance,
    source: {
      kind: "tool_call",
      id: context.toolCallId,
      meta: { runId: context.runId, stepId: context.stepId },
    },
  });
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
  rememberStandingInstruction,
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
  instructionWordsAreTheUsers({ userId, threadId, words, names }) {
    if (threadId === undefined || words === undefined) return Promise.resolve(false);

    return findUserWordsInThread({ userId, threadId, words, names }).then((id) => id !== null);
  },
  async editInstruction({ input, context }) {
    const provenance = await instructionProvenance(context, "system.edit_instruction", {
      words: input.directive,
      names: [],
    });

    if (provenance === null) return NOT_SAID_IN_CHAT;

    return editStandingInstruction({
      userId: context.userId,
      factId: input.factId,
      directive: input.directive,
      senderLabel: input.senderLabel,
      provenance,
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
