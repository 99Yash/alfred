import {
  publishDomainEvent,
  publishEvent,
  type EmailTriageClassifiedPayload,
} from "@alfred/assistant/triggers";
import {
  documentAskReducer,
  gmailMessageLocatorSchema,
  proposeReconcileCandidates,
  reconcileEvidence,
  selectPrimaryReconciledObject,
  type ReconciledObject,
} from "@alfred/assistant/connections";
import { settings, type FeatureFlags, type UserSettings } from "@alfred/assistant/settings";
import {
  readSenderPerson,
  readUserContextLine,
  senderSuppressions,
  type ReportedSenderSuppressions,
  type SenderPersonRead,
} from "../knowledge";
import {
  resolvePaymentTodoFromReceipt,
  resolveTodosForGmailSource,
  suggestTodo,
} from "@alfred/assistant/tasks";
import {
  classifyEmail,
  DEFAULT_TRIAGE_CATEGORY,
  type ClassifyAudit,
  type TriageClassification,
} from "./classify";
import { extractSenderContext } from "./sender-context";
import { senderExtractionEvent } from "./sender-extraction-event";
import { resolveSenderKind, triageSenderKindProjectionEnabled } from "./sender-kind";
import { resolveSenderRelationship } from "./sender-relationship";
import {
  getSenderPrior,
  incrementSenderPrior,
  senderKeyFor,
  senderPriorWriteKeyFor,
} from "./sender-priors";
import { mayBeUnflaggedSentMail } from "./sent-mail";
import {
  getDocumentAuthoredAt,
  getTriage,
  loadTriageContext,
  markGmailDocumentSent,
  upsertTriage,
  type TriageDocumentContext,
} from "./store";
import { reconcileThreadLabel } from "./tags";
import { getThreadState } from "./thread-state";
import { decideTriageTodo, type TriageTodoDecision } from "./todo-decision";
import { assembleObservations, type Observations } from "./observations";
import type { StepContext, StepResult } from "@alfred/assistant/execution";
import {
  documentAskProposalSchema,
  gmailTodoSources,
  isHttpError,
  isSentGmailMetadata,
  parseGmailDocumentMetadata,
  policyAuthority,
  senderContextSchema,
  triageCategorySchema,
  type AccountPersona,
  type GmailDocumentMetadata,
  type SenderContext,
  type SignificanceBand,
  type TodoObjectRef,
  type TodoSource,
  type TriageCategory,
  todoSourceKey,
  toMessage,
} from "@alfred/contracts";
import { gmailMailbox } from "@alfred/integrations/google";
import { logger, safeErrorDiagnostic } from "@alfred/logging";
import { triageRunReasonSchema } from "./workflow-input";
import { z } from "zod";

/**
 * Email triage workflow (ADR-0025): one `email_triage` row per (user, thread),
 * steps classify → apply-label → open-document-ask → close-loop-todos. A reply
 * re-runs it; user overrides stay pinned.
 */

/**
 * The run state, declared once. Never hand-write a copy: `Step.run` params are
 * bivariant and this recipe's state is never parsed, so a drifted twin goes unchecked.
 */
export const emailTriageStateSchema = z.object({
  documentId: z.string(),
  reason: triageRunReasonSchema.optional(),
  sourceThreadId: z.string().optional(),
  category: triageCategorySchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().nullable().optional(),
  senderContext: senderContextSchema.optional(),
  force: z.boolean().optional(),
  /** Whole-thread closure, read by `classify` on reply runs only, used by `close-loop-todos`. */
  userAlreadyReplied: z.boolean().optional(),
  /** The ask `classify` proposed for this message, opened by `open-document-ask`. */
  documentAsk: z
    .object({ source: gmailMessageLocatorSchema, proposal: documentAskProposalSchema })
    .optional(),
  /** Faulted opens so far; indexes `DOCUMENT_ASK_OPEN_RETRY_DELAYS_MS`. */
  documentAskOpenRetries: z.number().int().min(0).optional(),
});

export type EmailTriageOperationState = z.infer<typeof emailTriageStateSchema>;

/** Run-history sentence per skip reason. Without one, a skip reads as "Run completed." (#561). */
const CLASSIFY_SKIP_SUMMARIES = {
  "triage-disabled": "Skipped: email tagging and action items are both off",
  "document-not-found": "Skipped: the document was deleted before the run started",
  "missing-thread-id": "Skipped: the document carries no Gmail thread id",
  "source-message-not-found": "Skipped: the Gmail message no longer exists",
  "sent-document": "Skipped: the message is the user's own sent mail",
  "thread-already-tagged": "Skipped: the thread is tagged and this message is not newer",
} as const;

type ClassifySkipReason = keyof typeof CLASSIFY_SKIP_SUMMARIES;

export async function runEmailTriageClassify<State extends EmailTriageOperationState>(
  ctx: StepContext<State>,
): Promise<StepResult<State, EmailTriageStepName>> {
  const skip = (
    reason: ClassifySkipReason,
    extra?: { category: TriageCategory },
  ): StepResult<State, EmailTriageStepName> => ({
    kind: "done",
    state: ctx.state,
    summary: CLASSIFY_SKIP_SUMMARIES[reason],
    output: { skipped: true, reason, ...extra },
  });

  // One bind for the step: the flags, the sender-kind switch, and the todo zone share one load.
  const userSettings = settings({ userId: ctx.userId });
  // Tagging gates the label, action items gate the todo. Both off: skip before any cost.
  const flags = await userSettings.flags();

  if (!flags.emailTagging && !flags.actionItems) {
    await ctx.log(`classify: skipped reason=triage-disabled (tagging + action-items off)`);

    return skip("triage-disabled");
  }

  const ctxData = await loadTriageContext(ctx.state.documentId, ctx.userId);

  if (!ctxData) {
    // Deleted between enqueue and run. Not an error.
    await ctx.log(`document gone: ${ctx.state.documentId}`);

    return skip("document-not-found");
  }

  const sourceThreadId = ctxData.document.sourceThreadId;

  if (!sourceThreadId) {
    // Gmail always sets one; a malformed ingest must not crash the worker.
    await ctx.log(`document missing sourceThreadId: ${ctx.state.documentId}`);

    return skip("missing-thread-id");
  }

  // Gmail can add `SENT` after our first insert, so check live when unsure (ADR-0051 #7).
  const sentStatus = await sentDocumentStatusAtClassifyTime(ctxData);

  if (sentStatus.kind === "missing") {
    await ctx.log(
      `classify: doc=${ctx.state.documentId} source message missing in Gmail — skipping`,
    );

    return skip("source-message-not-found");
  }

  if (sentStatus.kind === "sent") {
    if (sentStatus.source === "live") {
      await markGmailDocumentSent({
        userId: ctx.userId,
        documentId: ctx.state.documentId,
        liveLabelIds: sentStatus.labelIds,
      });
    }

    await ctx.log(
      `classify: doc=${ctx.state.documentId} is the user's own sent mail (${sentStatus.source}) — skipping (ADR-0051 #7)`,
    );

    return skip("sent-document");
  }

  const senderContextResult = extractSenderContext({
    fromHeader: ctxData.document.metadata.from ?? null,
    subject: ctxData.document.title,
    body: ctxData.document.content,
  });

  const senderContext = senderContextResult.context;

  // A row from THIS run is reused, so a retry does not re-bill the model.
  const existing = await getTriage(ctx.userId, sourceThreadId);

  // Skip a labelled thread only when this message is provably not newer
  // (re-delivered push, out-of-order ingest). Unknown order re-classifies:
  // missing a real reply costs more than an extra call.
  if (existing && existing.runId !== ctx.runId && existing.appliedLabelId && !ctx.state.force) {
    const incomingAuthoredAt = ctxData.document.authoredAt;

    const priorAuthoredAt = existing.documentId
      ? await getDocumentAuthoredAt(ctx.userId, existing.documentId)
      : null;

    // Date headers are per second, so an equal timestamp is not a duplicate
    // unless it is the same document.
    const isSameStoredDocument = existing.documentId === ctx.state.documentId;

    const provablyNotNewer =
      isSameStoredDocument ||
      (incomingAuthoredAt != null &&
        priorAuthoredAt != null &&
        incomingAuthoredAt.getTime() < priorAuthoredAt.getTime());

    if (provablyNotNewer) {
      await ctx.log(
        `classify: thread=${sourceThreadId} already tagged (${existing.category}); ` +
          `doc=${ctx.state.documentId} not newer than prior message — skipping re-process`,
      );

      return skip("thread-already-tagged", { category: existing.category });
    }
  }

  let classification: TriageClassification;
  let model: string;
  let audit: ClassifyAudit | null = null;
  let observations: Observations | null = null;
  // This run owns the row. Gates the side effects below on both paths (#157).
  let written = false;
  let senderSignificanceBand: SignificanceBand | null = null;
  // Before the row write on both paths, so the stored trace holds the facts the side effects use.
  let todo: TriageTodoDecision;
  const reusedExistingRow = Boolean(existing && existing.runId === ctx.runId);

  const decideTodo = (suppressions: ReportedSenderSuppressions) =>
    decideTriageTodo({
      userId: ctx.userId,
      settings: userSettings,
      sourceThreadId,
      reason: ctx.state.reason,
      classification,
      document: ctxData.document,
      senderAddress: senderContextResult.senderAddress,
      // On reuse there are no observations, so read the row's verdict (#517 D1).
      isColdContact:
        observations?.senderRelationshipIsCold ??
        (reusedExistingRow ? (existing?.senderRelationshipIsCold ?? false) : false),
      actionItemsEnabled: flags.actionItems,
      suppressions,
    });

  if (reusedExistingRow && existing) {
    classification = {
      category: existing.category,
      confidence: existing.confidence,
      rationale: existing.rationale ?? "",
      // Without these the reuse path dropped the minted todo (#157).
      todoSuggestion: existing.todoSuggestion ?? undefined,
      todoDecision: existing.todoDecision ?? undefined,
      documentAsk:
        existing.documentId === ctx.state.documentId
          ? (existing.documentAsk ?? undefined)
          : undefined,
    };
    model = existing.model;
    // A prior attempt may have written the row and died before the side effects (#157).
    written = true;
    senderSignificanceBand = existing.senderSignificanceBand ?? null;
    // No gather runs on reuse, so the todo lane loads the suppressions itself.
    todo = await decideTodo(
      await senderSuppressions({ userId: ctx.userId, onReadFailure: "report" }),
    );
    await ctx.log(`classify: reuse existing thread row category=${classification.category}`);
  } else {
    // Before the try, so the fallback path still has them for the trace.
    const gathered = await gatherObservations({
      userId: ctx.userId,
      settings: userSettings,
      documentId: ctx.state.documentId,
      sourceThreadId,
      document: ctxData.document,
      accountId: ctxData.document.accountId,
      persona: ctxData.persona,
      senderContext,
      senderAddress: senderContextResult.senderAddress,
    });

    observations = gathered.observations;

    try {
      const result = await classifyEmail({
        userId: ctx.userId,
        document: {
          id: ctxData.document.id,
          title: ctxData.document.title,
          content: ctxData.document.content,
          authoredAt: ctxData.document.authoredAt,
          metadata: ctxData.document.metadata,
        },
        senderContext,
        observations,
        identity: ctxData.identity,
        runId: ctx.runId,
        stepId: "classify",
        idempotencyKey: ctx.idempotencyKey,
      });

      classification = result.classification;
      model = result.model;
      audit = result.audit;
    } catch (err) {
      // A low-confidence label beats none. The error goes in `rationale` so the row
      // says why. `senderPriorWriteKeyFor` never learns from `model="fallback"`.
      const errMsg = toMessage(err);
      await ctx.log(`classify failed; falling through to default: ${errMsg}`);
      classification = {
        category: DEFAULT_TRIAGE_CATEGORY,
        confidence: 0.5,
        rationale: `Classifier failed; default applied. err=${errMsg.slice(0, 500)}`,
      };
      model = "fallback";
    }

    // For the rail's demotion (ADR-0064). Null reads as neutral.
    senderSignificanceBand =
      gathered.sender.kind === "found" ? (gathered.sender.significance?.band ?? null) : null;

    todo = await decideTodo(gathered.suppressions);

    const decisionTrace = senderExtractionEvent({
      senderContextResult,
      observations,
      audit,
      classification,
      todoSuggested: todo.outcome.kind !== "none",
      standingSuppression: todo.standingSuppression,
    });

    // `written` is false when a run for a newer message owns the row; then skip
    // the side effects. The trace commits in the same transaction as the row.
    const upserted = await upsertTriage({
      userId: ctx.userId,
      sourceThreadId,
      documentId: ctx.state.documentId,
      category: classification.category,
      confidence: classification.confidence,
      rationale: classification.rationale,
      documentAsk: classification.documentAsk ?? null,
      model,
      runId: ctx.runId,
      // So a same-run retry can re-mint the todo (#157).
      todoSuggestion: classification.todoSuggestion ?? null,
      todoDecision: classification.todoDecision ?? null,
      senderSignificanceBand,
      // The reuse path has no observations, so it reads this from the row (#517 D1).
      senderRelationshipIsCold: observations.senderRelationshipIsCold,
      decisionTrace: {
        stepId: "classify",
        attempt: ctx.attempt,
        kind: "triage.classification",
        trace: decisionTrace,
      },
      authoredAt: ctxData.document.authoredAt,
    });

    written = upserted.written;

    if (written) {
      ctx.trace("triage.classification", decisionTrace);
    }
  }

  // Side effects run on both paths (#157). Each is idempotent, so a re-entry is safe.
  // The document ask is not one of them: it travels in run state to `open-document-ask`.

  // Best-effort and outside the row transaction. The 5-minute rail poll recovers a lost frame.
  if (written) {
    try {
      await publishEvent({
        untransacted: true,
        userId: ctx.userId,
        kind: "inbox.updated",
        payload: { reason: "triaged", count: 1 },
      });
    } catch (err) {
      await ctx.log(`inbox.updated publish failed: ${toMessage(err)}`);
    }
  }

  // ADR-0098: consumers decide from this snapshot, so triage imports none of them.
  // Best-effort: a failure is logged, not thrown.
  if (written) {
    // `satisfies`, not an annotation: a wrong field fails at this literal,
    // and the literal keeps its narrow type.
    const todoDecision = classification.todoDecision;

    const payload = {
      triage: {
        documentId: ctx.state.documentId,
        sourceThreadId,
        triageRunId: ctx.runId,
        category: classification.category,
        confidence: classification.confidence,
        model,
        todoDecision: todoDecision
          ? { outcome: todoDecision.outcome, note: todoDecision.note ?? null }
          : null,
        senderRelationshipIsCold:
          observations?.senderRelationshipIsCold ?? existing?.senderRelationshipIsCold ?? null,
        senderSignificanceBand,
      },
      triageStep: { runId: ctx.runId, stepId: "classify", attempt: ctx.attempt },
      triageReason: ctx.state.reason ?? null,
      sender: {
        address: senderContextResult.senderAddress,
        effectiveAuthor: senderContext.effectiveAuthor,
      },
      mailbox: {
        accountId: ctxData.document.accountId,
        address: ctxData.identity.mailboxAddress,
      },
      thread: {
        inboundAuthoredAt: ctxData.document.authoredAt?.toISOString() ?? null,
        lastUserReplyAt: observations?.thread.lastUserReplyAt?.toISOString() ?? null,
        newestDirection: observations?.thread.newestDirection ?? null,
      },
    } satisfies EmailTriageClassifiedPayload;

    try {
      await publishDomainEvent({
        userId: ctx.userId,
        source: "email-triage",
        type: "classified",
        eventId: `${sourceThreadId}:${ctx.state.documentId}:${ctx.runId}`,
        payload,
      });
    } catch (err) {
      await ctx.log(`email-triage.classified publish failed: ${toMessage(err)}`);
    }
  }

  if (todo.standingSuppression.kind === "read_failed") {
    await ctx.log(
      `standing_instruction: read failed for block_todo_suggestion (suppressing todo): ${toMessage(todo.standingSuppression.error)}`,
    );
  }

  // Unknown closure mints the todo and makes `close-loop-todos` a no-op.
  if (todo.closure.kind === "read_failed") {
    await ctx.log(
      `close-loop-todos: thread closure read failed for ${sourceThreadId} (treating as not-replied)`,
    );
  }

  // Sender-prior bump (ADR-0051 #2). It only adds, so each document teaches once:
  // not on reuse, not on a reply re-eval, and not on a `force` re-run of a document
  // an earlier run already stored. A missed vote is cheap; a duplicate is permanent.
  const documentAlreadyTaughtPrior = Boolean(
    existing && existing.runId !== ctx.runId && existing.documentId === ctx.state.documentId,
  );

  if (
    !reusedExistingRow &&
    written &&
    ctx.state.reason !== "reply" &&
    !documentAlreadyTaughtPrior
  ) {
    const docIsSent = isSentGmailMetadata(ctxData.document.metadata);

    const baseSenderKey = senderPriorWriteKeyFor({
      senderContext,
      senderAddress: senderContextResult.senderAddress,
      isSent: docIsSent,
      model,
    });

    const senderKey =
      baseSenderKey ??
      (!docIsSent &&
      model !== "fallback" &&
      observations?.senderKind &&
      senderContextResult.senderAddress
        ? senderContextResult.senderAddress.toLowerCase()
        : null);

    if (senderKey) {
      try {
        await incrementSenderPrior({
          userId: ctx.userId,
          senderKey,
          category: classification.category,
          displayName: ctxData.document.metadata.from ?? null,
        });
      } catch (err) {
        await ctx.log(`sender_prior write failed (non-fatal): ${toMessage(err)}`);
      }
    }
  }

  // Rail todo (ADR-0050). `suggest_todo` merges on source overlap, so a re-run
  // does not duplicate. A failure is non-fatal: the label and row are the contract.
  if (written && todo.outcome.kind === "suppressed") {
    const { suppression } = todo.outcome;

    switch (suppression.kind) {
      case "standing_instruction": {
        const { match } = suppression;

        await ctx.log(
          `suggest_todo: suppressed reason=standing_instruction ` +
            `effect=${match.effect} fact=${match.factId} sender=${match.matchedEmail}`,
        );
        break;
      }

      case "standing_instruction_read_failed":
        await ctx.log(`suggest_todo: suppressed reason=standing_instruction_read_failed`);
        break;

      case "gate":
        await ctx.log(`suggest_todo: suppressed reason=${suppression.reason}`);
        break;

      case "action_items_off":
        // No log line: the user turned action items off.
        break;
    }
  } else if (written && todo.outcome.kind === "mint") {
    const { todo: suggestion } = todo.outcome;
    const sender = ctxData.document.metadata.from ?? null;

    // A failed read loses only the object ref; the thread and loop refs still merge.
    const object = await resolveTodoObject({
      userId: ctx.userId,
      documentId: ctx.state.documentId,
      document: ctxData.document,
      sender,
    }).catch(async (err: unknown) => {
      await ctx.log(`suggest_todo: object resolve failed (non-fatal): ${toMessage(err)}`);

      return null;
    });

    try {
      // The object and `loop` refs fold a thing that re-notifies on new threads into one todo
      // (#355, ADR-0092 A1).
      const sources = gmailTodoSources({
        threadId: sourceThreadId,
        subject: ctxData.document.title,
        sender,
        object,
      });

      const suggested = await suggestTodo({
        userId: ctx.userId,
        // No tool call: the step key names the action inside the run.
        attribution: {
          actor: "agent",
          runId: ctx.runId,
          toolCallId: ctx.idempotencyKey,
          ...policyAuthority("triage.todo_gate"),
          cause: "suggested",
        },
        name: suggestion.name,
        assist: suggestion.assist,
        sources,
      });

      await ctx.log(
        `suggest_todo: ${suggested.status} todo=${suggested.todoId} category=${classification.category}` +
          (object ? ` ${objectLogField(object, sources)}` : ""),
      );
    } catch (err) {
      await ctx.log(`suggest_todo failed (non-fatal): ${toMessage(err)}`);
    }
  }

  await ctx.log(
    `classify: doc=${ctx.state.documentId} thread=${sourceThreadId} ` +
      `category=${classification.category} ` +
      `confidence=${classification.confidence.toFixed(2)} model=${model}`,
  );

  return {
    kind: "next",
    state: {
      ...ctx.state,
      sourceThreadId,
      category: classification.category,
      confidence: classification.confidence,
      rationale: classification.rationale,
      senderContext,
      // Reused by `close-loop-todos`; a second read could see a newer inbound.
      userAlreadyReplied: todo.closure.kind === "read" && todo.closure.userAlreadyReplied,
      // Not gated on `written`: an older ask that loses the row race is still an ask.
      // Set on every path, so a stale ask cannot survive into this run.
      documentAsk:
        classification.documentAsk && ctxData.document.accountId
          ? {
              source: {
                accountId: ctxData.document.accountId,
                messageId: ctxData.document.sourceId,
              },
              proposal: classification.documentAsk,
            }
          : undefined,
      documentAskOpenRetries: 0,
    },
    nextStep: EMAIL_TRIAGE_EDGES.classify,
  };
}

/**
 * After the label: on a reply run where the user's message is newest, dismiss
 * this thread's unpromoted `suggested` todos (ADR-0050). Promoted `open` todos stay.
 * Reads the closure fact, never the category, because the model can miss rule 18.
 * Best-effort: a failure is logged and never touches the label.
 */
export async function runEmailTriageCloseLoopTodos<State extends EmailTriageOperationState>(
  ctx: StepContext<State>,
): Promise<StepResult<State, EmailTriageStepName>> {
  const sourceThreadId = ctx.state.sourceThreadId;

  if (!sourceThreadId) {
    throw new Error(
      "[email-triage] close-loop-todos entered without sourceThreadId; classify step did not commit",
    );
  }

  // No output keys, but the history row needs a `summary` or it reads "Run completed."
  const summarize = (tail?: string): string => {
    const category = ctx.state.category;

    const confidence =
      ctx.state.confidence !== undefined ? ` (confidence ${ctx.state.confidence.toFixed(2)})` : "";

    const head = category
      ? `Triaged as ${category}${confidence}`
      : `Triaged thread ${sourceThreadId}`;

    return tail ? `${head}; ${tail}` : head;
  };

  const done = (summaryTail?: string): StepResult<State, EmailTriageStepName> => ({
    kind: "done",
    state: ctx.state,
    summary: summarize(summaryTail),
  });

  // Two closers: a user reply, and a payment receipt. A receipt often lands on a
  // new thread, so it cannot sit behind the reply gate.
  const isPaymentTriage = ctx.state.category === "payment";

  if (ctx.state.reason !== "reply" && !isPaymentTriage) return done();

  // Best-effort from here, flag read included. The label already landed (#1168).
  try {
    // Same flag as the mint: with action items off, leave rail rows alone.
    const flags = await settings({ userId: ctx.userId }).flags();

    if (!flags.actionItems) {
      await ctx.log(
        `close-loop-todos: thread=${sourceThreadId} — no retraction (action-items disabled)`,
      );

      return done("retraction skipped (action-items disabled)");
    }

    let dismissed = 0;
    const summaryParts: string[] = [];

    if (ctx.state.reason === "reply") {
      if (!ctx.state.userAlreadyReplied) {
        await ctx.log(
          `close-loop-todos: thread=${sourceThreadId} — no retraction (classify read no user reply)`,
        );

        summaryParts.push("reply re-eval, no open suggestion to close");
      } else {
        const resolved = await resolveTodosForGmailSource(
          {
            userId: ctx.userId,
            sourceThreadId,
            // Never `open`: the user accepted it, and a holding reply is not closure.
            statuses: ["suggested"],
          },
          { actor: "system", ...policyAuthority("todo.reply_retraction"), cause: "reply_detected" },
        );

        await ctx.log(
          `close-loop-todos: thread=${sourceThreadId} newest=sent reason=${resolved.auditReason ?? "unknown"} ` +
            `status=${resolved.status} dismissed=${resolved.ok ? resolved.dismissedCount : 0}`,
        );

        dismissed += resolved.ok ? resolved.dismissedCount : 0;
        summaryParts.push(
          dismissed > 0
            ? `reply re-eval, closed ${dismissed} suggestion${dismissed === 1 ? "" : "s"}`
            : "reply re-eval, no open suggestion to close",
        );
      }
    }

    if (isPaymentTriage) {
      const payment = await resolvePaymentTodoFromReceipt({
        userId: ctx.userId,
        receiptDocumentId: ctx.state.documentId,
      });

      await ctx.log(
        `close-loop-todos: payment receipt=${ctx.state.documentId} ` +
          `status=${payment.status}${payment.status === "dismissed" ? ` dismissed=${payment.todoIds.length}` : ""}`,
      );

      if (payment.status === "dismissed") {
        dismissed += payment.todoIds.length;
        summaryParts.push(
          `payment receipt, closed ${payment.todoIds.length} todo${payment.todoIds.length === 1 ? "" : "s"}`,
        );
      } else if (payment.status === "ambiguous") {
        summaryParts.push("payment receipt, matching payment is ambiguous; kept todo live");
      }
    }

    return done(summaryParts.join("; "));
  } catch (err) {
    await ctx.log(`close-loop-todos failed (non-fatal): ${toMessage(err)}`);

    return done("retraction failed (non-fatal)");
  }
}

export async function runEmailTriageApplyLabel<State extends EmailTriageOperationState>(
  ctx: StepContext<State>,
): Promise<StepResult<State, EmailTriageStepName>> {
  const category = ctx.state.category;
  const sourceThreadId = ctx.state.sourceThreadId;

  if (!category || !sourceThreadId) {
    throw new Error(
      "[email-triage] apply-label entered without category/sourceThreadId; classify step did not commit",
    );
  }

  // Every path forwards to the next step (#1168). A fault must not throw:
  // that ends the run before the retraction. `applied_label_id` stays NULL, so the
  // next inbound re-labels.
  let flags: FeatureFlags;

  try {
    flags = await settings({ userId: ctx.userId }).flags();
  } catch (err) {
    await ctx.log(`apply-label failed (non-fatal): ${toMessage(err)}`);

    return {
      kind: "next",
      state: { ...ctx.state },
      nextStep: EMAIL_TRIAGE_EDGES["apply-label"],
    };
  }

  if (!flags.emailTagging) {
    await ctx.log(`apply-label: skipped reason=tagging-disabled`);

    return {
      kind: "next",
      state: { ...ctx.state },
      nextStep: EMAIL_TRIAGE_EDGES["apply-label"],
    };
  }

  let outcome: Awaited<ReturnType<typeof reconcileThreadLabel>>;

  try {
    outcome = await reconcileThreadLabel({
      userId: ctx.userId,
      sourceThreadId,
      fallbackDocumentId: ctx.state.documentId,
    });
  } catch (err) {
    await ctx.log(`apply-label failed (non-fatal): ${toMessage(err)}`);

    return {
      kind: "next",
      state: { ...ctx.state },
      nextStep: EMAIL_TRIAGE_EDGES["apply-label"],
    };
  }

  if (!outcome.applied) {
    await ctx.log(`apply-label: skipped reason=${outcome.reason}`);

    return {
      kind: "next",
      state: { ...ctx.state },
      nextStep: EMAIL_TRIAGE_EDGES["apply-label"],
    };
  }

  await ctx.log(
    `apply-label: doc=${ctx.state.documentId} canonical=${outcome.targetDocId} ` +
      `thread=${sourceThreadId} applied=${outcome.category} (${outcome.appliedLabelId}) ` +
      `removed=${outcome.removedLabelIds.length} ` +
      `siblingsStripped=${outcome.strippedSiblings.length}/${outcome.siblingCount}`,
  );

  return {
    kind: "next",
    state: { ...ctx.state },
    nextStep: EMAIL_TRIAGE_EDGES["apply-label"],
  };
}

/** Defer delays for a faulted open. Past the last one the ask is logged as lost. */
const DOCUMENT_ASK_OPEN_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

/**
 * Opens the ask `classify` proposed. A fault must not throw: that fails the run
 * terminally and `close-loop-todos` never runs. It defers on the bounded schedule
 * instead. `classify` is the only caller of `open`, so a lost ask stays lost.
 */
export async function runEmailTriageOpenDocumentAsk<State extends EmailTriageOperationState>(
  ctx: StepContext<State>,
): Promise<StepResult<State, EmailTriageStepName>> {
  const next: StepResult<State, EmailTriageStepName> = {
    kind: "next",
    state: { ...ctx.state },
    nextStep: EMAIL_TRIAGE_EDGES["open-document-ask"],
  };

  const documentAsk = ctx.state.documentAsk;

  if (!documentAsk) return next;

  try {
    // Idempotent per source message, so a deferred re-entry is safe.
    const opened = await documentAskReducer.open({
      userId: ctx.userId,
      source: documentAsk.source,
      proposal: documentAsk.proposal,
      observedAt: new Date(),
    });

    if (opened.kind === "noop") await ctx.log(`document_ask: open noop reason=${opened.reason}`);

    return next;
  } catch (err) {
    const retries = ctx.state.documentAskOpenRetries ?? 0;
    const delay = DOCUMENT_ASK_OPEN_RETRY_DELAYS_MS[retries];
    // Bounded for readability; `ctx.log` applies the hard cap.
    const reason = toMessage(err).slice(0, 500);

    if (delay === undefined) {
      // The progress row is reaped after 7 days, so the loss also goes to the process log.
      logger.warn(
        {
          openError: safeErrorDiagnostic(err),
          event: "triage_document_ask_lost",
          runId: ctx.runId,
          sourceMessageId: documentAsk.source.messageId,
          retries,
        },
        "triage: document ask lost after retries",
      );
      await ctx.log(`document_ask: open failed after ${retries} retries; ask lost: ${reason}`);

      return next;
    }

    await ctx.log(`document_ask: open failed (retry ${retries + 1}): ${reason}`);

    return {
      kind: "defer",
      state: { ...ctx.state, documentAskOpenRetries: retries + 1 },
      retryAt: new Date(Date.now() + delay),
      reason: "retry_scheduled",
    };
  }
}

type SentDocumentStatus =
  | { kind: "not-sent" }
  | { kind: "missing" }
  | { kind: "sent"; source: "stored" }
  | { kind: "sent"; source: "live"; labelIds: readonly string[] };

/**
 * Checks Gmail live only when the stored row is ambiguous (#439). So a mail
 * deleted after ingest usually wastes one classify instead of a clean `missing`
 * skip; apply-label then handles the 404 (#277).
 */
async function sentDocumentStatusAtClassifyTime(
  ctxData: TriageDocumentContext,
): Promise<SentDocumentStatus> {
  if (isSentGmailMetadata(ctxData.document.metadata)) return { kind: "sent", source: "stored" };

  const ambiguous = mayBeUnflaggedSentMail({
    fromHeader: ctxData.document.metadata.from ?? null,
    // Never `identity.email`: it falls back to the primary email and breaks secondary mailboxes.
    mailboxAddress: ctxData.identity.mailboxAddress,
  });

  if (!ambiguous) return { kind: "not-sent" };

  try {
    const message = await gmailMailbox({ credentialId: ctxData.credentialId }).getMessage({
      id: ctxData.document.sourceId,
      format: "minimal",
    });

    const labelIds = message.labelIds ?? [];

    return isSentGmailMetadata(parseGmailDocumentMetadata({ labelIds }))
      ? { kind: "sent", source: "live", labelIds }
      : { kind: "not-sent" };
  } catch (err) {
    if (isHttpError(err) && err.status === 404) return { kind: "missing" };
    throw err;
  }
}

/**
 * A todo ref merges live todos and suppresses a resolved one for 30 days, so only a hard edge may
 * give one. A `prefix` is a guess from a short sha, and a `nomination` never closes an ask.
 */
const TODO_REF_MATCHES = {
  exact: true,
  identity: true,
  prefix: false,
  nomination: false,
} satisfies Record<ReconciledObject<"about">["key"]["match"], boolean>;

/** Names the resolved object, and says so when its kind gave the todo no ref (`todoIdentity`). */
function objectLogField(object: TodoObjectRef, sources: readonly TodoSource[]): string {
  const key = todoSourceKey({
    provider: object.provider,
    kind: object.kind,
    id: object.externalId,
  });

  const carried = sources.some((source) => todoSourceKey(source) === key);

  return `object=${object.provider}:${object.kind}:${object.externalId}${carried ? "" : " (no ref)"}`;
}

/**
 * The `integration_objects` row this mail is about (ADR-0092 A1), by the briefing's `about`
 * reading and precedence rule. `null` when the mail names no stored object by a hard edge.
 */
async function resolveTodoObject(args: {
  userId: string;
  documentId: string;
  document: { title: string | null; content: string };
  sender: string | null;
}): Promise<TodoObjectRef | null> {
  const candidates = proposeReconcileCandidates(
    {
      id: args.documentId,
      text: { subject: args.document.title ?? "", content: args.document.content },
    },
    { reading: "about", sender: args.sender },
  );

  if (!candidates) return null;

  const reconciled = await reconcileEvidence({ userId: args.userId, subjects: [candidates] });
  const primary = selectPrimaryReconciledObject(reconciled.get(args.documentId));

  if (!primary || !TODO_REF_MATCHES[primary.key.match]) return null;

  const { state } = primary;

  return {
    provider: state.provider,
    kind: state.kind,
    externalId: state.externalId,
    url: state.url,
  };
}

export interface GatheredObservations {
  observations: Observations;
  /** For the rail band (ADR-0064). Not a classifier input. */
  sender: SenderPersonRead;
  /** One `"report"` load. The todo lane matches against it too. */
  suppressions: ReportedSenderSuppressions;
}

/**
 * The IO for `assembleObservations` (ADR-0051 §4a). Every read is best-effort.
 * Dry-run scripts call this too, so a replay sees the facts the live classify sees.
 * The sender's `person` row and the sender suppressions are each read one time here.
 */
export async function gatherObservations(args: {
  userId: string;
  /** The same user's bind. The live classify passes its step bind. */
  settings: UserSettings;
  documentId: string;
  sourceThreadId: string;
  document: { title: string | null; content: string; metadata: GmailDocumentMetadata };
  /** Scopes a per-account standing instruction. */
  accountId: string | null;
  persona: AccountPersona | null;
  senderContext: SenderContext;
  senderAddress: string | null;
}): Promise<GatheredObservations> {
  const meta = args.document.metadata;
  const labelIds = meta.labelIds ?? [];

  const isHumanSender = args.senderContext.effectiveAuthor === "person";

  const [thread, senderKindEnabled, suppressions, userContext, sender] = await Promise.all([
    getThreadState({
      userId: args.userId,
      sourceThreadId: args.sourceThreadId,
      excludeDocumentId: args.documentId,
    }).catch(() => ({
      lastUserReplyAt: null,
      newestDirection: null,
      messageCount: 0,
      recentMessages: [],
    })),
    triageSenderKindProjectionEnabled(args.settings).catch(() => false),
    // Read before the model call. A blip makes every `match` report `read_failed`,
    // so the trace can tell none from unknown.
    senderSuppressions({ userId: args.userId, onReadFailure: "report" }),
    // Cold-start prior (ADR-0050 D1). One point read, never a memory search (#435).
    // A flag, because null alone cannot tell a failure from no chunk.
    readUserContextLine(args.userId)
      .then((line) => ({ line, readFailed: false }))
      .catch(() => ({ line: null, readFailed: true })),
    readSenderPerson(args.userId, args.senderAddress),
  ]);

  // This sender's standing instruction.
  const standing = suppressions.match(
    { sender: args.senderAddress ?? meta.from ?? null, accountId: args.accountId },
    "demote_demand",
  );

  const senderKind =
    senderKindEnabled && args.senderAddress
      ? await resolveSenderKind(args.userId, args.senderAddress)
      : null;

  const baseSenderKey = senderKeyFor(args.senderContext, args.senderAddress);

  const senderKey =
    baseSenderKey ?? (senderKind && args.senderAddress ? args.senderAddress.toLowerCase() : null);

  const senderPrior = senderKey
    ? await getSenderPrior(args.userId, senderKey).catch(() => null)
    : null;

  const usePersonTreatment = isHumanSender && senderKind == null;

  // Best-effort hint: a failed read is not a known contact.
  const knownContact = usePersonTreatment && sender.kind === "found";

  const relationship = await resolveSenderRelationship({
    userId: args.userId,
    sender,
    isHumanSender: usePersonTreatment,
  });

  const signalText = [
    meta.from,
    meta.to,
    meta.cc,
    meta.snippet,
    args.document.title,
    args.document.content,
    ...labelIds,
  ]
    .filter(Boolean)
    .join("\n");

  const observations = assembleObservations({
    senderKey,
    senderPrior,
    persona: args.persona,
    thread,
    knownContact,
    senderRelationship: relationship.descriptor,
    senderRelationshipIsCold: relationship.isColdContact,
    senderKind,
    standingInstruction:
      standing.kind === "suppressed"
        ? {
            factId: standing.match.factId,
            directive: standing.match.value.directive,
            phrasing: standing.match.value.phrasing,
          }
        : null,
    standingInstructionReadFailed: standing.kind === "read_failed",
    userContext: userContext.line,
    userContextReadFailed: userContext.readFailed,
    labelIds,
    signalText,
  });

  return { observations, sender, suppressions };
}

/** The step set. The order lives in `EMAIL_TRIAGE_EDGES`, not in this key order. */
export const emailTriageSteps = {
  classify: { id: "classify", run: runEmailTriageClassify },
  "apply-label": { id: "apply-label", run: runEmailTriageApplyLabel },
  "open-document-ask": { id: "open-document-ask", run: runEmailTriageOpenDocumentAsk },
  "close-loop-todos": { id: "close-loop-todos", run: runEmailTriageCloseLoopTodos },
} as const;

export type EmailTriageStepName = keyof typeof emailTriageSteps;

/** Entry step and edges. `null` ends the run. To reorder the pipeline, edit only this table. */
export const EMAIL_TRIAGE_INITIAL_STEP = "classify" satisfies EmailTriageStepName;

export const EMAIL_TRIAGE_EDGES = {
  classify: "apply-label",
  // The ask opens after the label, so an ask fault cannot delay or remove the label.
  // It opens before `close-loop-todos`, which ends the run and owns the summary.
  "apply-label": "open-document-ask",
  "open-document-ask": "close-loop-todos",
  "close-loop-todos": null,
} as const satisfies Record<EmailTriageStepName, EmailTriageStepName | null>;
