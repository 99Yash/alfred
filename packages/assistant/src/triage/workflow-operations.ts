import {
  publishDomainEvent,
  publishEvent,
  type EmailTriageClassifiedPayload,
} from "@alfred/assistant/triggers";
import { documentAskReducer, gmailMessageLocatorSchema } from "@alfred/assistant/connections";
import { resolveFeatureFlags, resolveTimezone } from "@alfred/assistant/settings";
import {
  findActiveSenderSuppression,
  findSenderSuppression,
  getSenderSignificance,
  listActiveSuppressionInstructions,
  readUserContextLine,
} from "../knowledge";
import {
  resolvePaymentTodoFromReceipt,
  resolveTodosForGmailSource,
  suggestTodo,
} from "@alfred/assistant/tasks";
import {
  classifyEmail,
  DEFAULT_TRIAGE_CATEGORY,
  resolveTodoSuggestion,
  todoSuppressionReason,
  type AssistDateAnchor,
  type ClassifyAudit,
  type TriageClassification,
} from "./classify";
import { isKnownContact } from "./contacts";
import { extractSenderContext } from "./sender-context";
import { senderExtractionEvent } from "./sender-extraction-event";
import { resolveSenderKind, triageSenderKindProjectionEnabled } from "./sender-kind";
import { RELATIONSHIP_READ_FAILED, resolveSenderRelationship } from "./sender-relationship";
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
import { getThreadState, readGmailThreadClosure, userRepliedAfterMessage } from "./thread-state";
import { assembleObservations, type Observations } from "./observations";
import type { StepContext, StepResult } from "@alfred/assistant/execution";
import {
  documentAskProposalSchema,
  gmailTodoSources,
  isHttpError,
  isSentGmailMetadata,
  senderContextSchema,
  triageCategorySchema,
  type AccountPersona,
  type GmailDocumentMetadata,
  type SenderContext,
  type SignificanceBand,
  type TriageCategory,
  toMessage,
} from "@alfred/contracts";
import { getFreshAccessToken, getMessage } from "@alfred/integrations/google";
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

  // Tagging gates the label, action items gate the todo. Both off: skip before any cost.
  const flags = await resolveFeatureFlags(ctx.userId);

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

  const authoredAt = ctxData.document.authoredAt;

  let classification: TriageClassification;
  let model: string;
  let audit: ClassifyAudit | null = null;
  let observations: Awaited<ReturnType<typeof gatherObservations>> | null = null;
  // This run owns the row. Gates the side effects below on both paths (#157).
  let written = false;
  let senderSignificanceBand: SignificanceBand | null = null;
  let todoSuggestion: ReturnType<typeof resolveTodoSuggestion> = null;
  let standingSuppression: Awaited<ReturnType<typeof findActiveSenderSuppression>> = null;
  let standingSuppressionReadFailed = false;
  let standingSuppressionReadError: string | null = null;
  // From one closure read, on reply runs only.
  // `userAlreadyReplied` (newest message is the user's) gates the retraction.
  // `documentRepliedAfter` (user replied after THIS message) gates the mint.
  // They differ once a newer inbound exists, so the mint cannot use the first.
  let userAlreadyReplied = false;
  let documentRepliedAfter = false;
  let closureReadFailed = false;

  const resolveTodoAndStandingSuppression = async () => {
    // Resolve the zone only when a todo is proposed; `resolveTimezone` hits the DB.
    const assistDateAnchor: AssistDateAnchor | null =
      authoredAt && classification.todoSuggestion
        ? { sentAt: authoredAt, timezone: await resolveTimezone(ctx.userId) }
        : null;

    const nextTodoSuggestion = resolveTodoSuggestion(classification, assistDateAnchor);
    let nextStandingSuppression: Awaited<ReturnType<typeof findActiveSenderSuppression>> = null;
    let nextStandingSuppressionReadFailed = false;
    let nextStandingSuppressionReadError: string | null = null;
    let nextUserAlreadyReplied = false;
    let nextDocumentRepliedAfter = false;
    let nextClosureReadFailed = false;

    // Gate on the reason, not on a new todo: a reply run may retract an older live todo (ADR-0050).
    if (ctx.state.reason === "reply") {
      try {
        // Read the whole thread, so a fresh inbound after an old reply still counts as open.
        const closure = await readGmailThreadClosure({ userId: ctx.userId, sourceThreadId });
        nextUserAlreadyReplied = closure.userHasReplied;
        nextDocumentRepliedAfter = userRepliedAfterMessage(
          closure.lastUserReplyAt,
          ctxData.document.authoredAt,
        );
      } catch {
        // Unknown closure mints the todo and makes `close-loop-todos` a no-op.
        nextClosureReadFailed = true;
      }
    }

    if (nextTodoSuggestion) {
      try {
        nextStandingSuppression = await findActiveSenderSuppression(ctx.userId, {
          senderEmail: senderContextResult.senderAddress ?? ctxData.document.metadata.from ?? null,
          accountId: ctxData.document.accountId,
          effect: "block_todo_suggestion",
        });
      } catch (err) {
        nextStandingSuppressionReadFailed = true;
        nextStandingSuppressionReadError = toMessage(err);
      }
    }

    return {
      todoSuggestion: nextTodoSuggestion,
      standingSuppression: nextStandingSuppression,
      standingSuppressionReadFailed: nextStandingSuppressionReadFailed,
      standingSuppressionReadError: nextStandingSuppressionReadError,
      userAlreadyReplied: nextUserAlreadyReplied,
      documentRepliedAfter: nextDocumentRepliedAfter,
      closureReadFailed: nextClosureReadFailed,
    };
  };

  const reusedExistingRow = Boolean(existing && existing.runId === ctx.runId);

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
    ({
      todoSuggestion,
      standingSuppression,
      standingSuppressionReadFailed,
      standingSuppressionReadError,
      userAlreadyReplied,
      documentRepliedAfter,
      closureReadFailed,
    } = await resolveTodoAndStandingSuppression());
    await ctx.log(`classify: reuse existing thread row category=${classification.category}`);
  } else {
    // Before the try, so the fallback path still has them for the trace.
    observations = await gatherObservations({
      userId: ctx.userId,
      documentId: ctx.state.documentId,
      sourceThreadId,
      document: ctxData.document,
      accountId: ctxData.document.accountId,
      persona: ctxData.persona,
      senderContext,
      senderAddress: senderContextResult.senderAddress,
    });

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
    const senderSignificance = await getSenderSignificance(
      ctx.userId,
      senderContextResult.senderAddress,
    ).catch(() => null);

    senderSignificanceBand = senderSignificance?.band ?? null;

    // Before the row write, so the stored trace holds the facts the side effects use.
    ({
      todoSuggestion,
      standingSuppression,
      standingSuppressionReadFailed,
      standingSuppressionReadError,
      userAlreadyReplied,
      documentRepliedAfter,
      closureReadFailed,
    } = await resolveTodoAndStandingSuppression());

    const decisionTrace =
      observations == null
        ? null
        : senderExtractionEvent({
            senderContextResult,
            observations,
            audit,
            classification,
            todoSuggested: Boolean(todoSuggestion),
            standingSuppression,
            standingSuppressionReadFailed,
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
      senderSignificanceBand: senderSignificance?.band ?? null,
      // The reuse path has no observations, so it reads this from the row (#517 D1).
      senderRelationshipIsCold: observations?.senderRelationshipIsCold ?? null,
      decisionTrace: decisionTrace
        ? {
            stepId: "classify",
            attempt: ctx.attempt,
            kind: "triage.classification",
            trace: decisionTrace,
          }
        : undefined,
      authoredAt: ctxData.document.authoredAt,
    });

    written = upserted.written;

    if (written && decisionTrace) {
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
    // `satisfies`, not an annotation: `note` is normalized to `string | null`
    // because the payload must also be a `JsonObject`.
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

  if (standingSuppressionReadError) {
    await ctx.log(
      `standing_instruction: read failed for block_todo_suggestion (suppressing todo): ${standingSuppressionReadError}`,
    );
  }

  if (closureReadFailed) {
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
  const suppression = todoSuggestion
    ? todoSuppressionReason({
        sender: ctxData.document.metadata.from ?? null,
        subject: ctxData.document.title,
        signalText: [
          ctxData.document.title,
          ctxData.document.content,
          ctxData.document.metadata.snippet ?? null,
        ]
          .filter(Boolean)
          .join("\n"),
        // Not persisted, so absent on reuse; the tracker-sender regex covers that.
        collabActivity: classification.collabActivity ?? null,
        // On reuse there are no observations, so read the row's verdict (#517 D1).
        category: classification.category,
        isColdContact:
          observations?.senderRelationshipIsCold ??
          (reusedExistingRow ? (existing?.senderRelationshipIsCold ?? false) : false),
        // Per message on purpose. `observations.thread` and `newestDirection` both
        // read `sent` on a fresh inbound after an old reply and withheld its todo.
        userRepliedAfterMessage: documentRepliedAfter,
      })
    : null;

  if (written && todoSuggestion && standingSuppression) {
    await ctx.log(
      `suggest_todo: suppressed reason=standing_instruction ` +
        `effect=${standingSuppression.effect} fact=${standingSuppression.factId} ` +
        `sender=${standingSuppression.matchedEmail}`,
    );
  } else if (written && todoSuggestion && standingSuppressionReadFailed) {
    await ctx.log(`suggest_todo: suppressed reason=standing_instruction_read_failed`);
  } else if (written && todoSuggestion && suppression) {
    await ctx.log(`suggest_todo: suppressed reason=${suppression}`);
  } else if (written && todoSuggestion && flags.actionItems) {
    try {
      const suggested = await suggestTodo({
        userId: ctx.userId,
        agentRunId: ctx.runId,
        name: todoSuggestion.name,
        assist: todoSuggestion.assist,
        // A `loop` ref folds a tracker that re-notifies on new threads into one todo (#355).
        sources: gmailTodoSources({
          threadId: sourceThreadId,
          subject: ctxData.document.title,
          sender: ctxData.document.metadata.from ?? null,
        }),
      });

      await ctx.log(
        `suggest_todo: ${suggested.status} todo=${suggested.todoId} category=${classification.category}`,
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
      userAlreadyReplied,
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
    const flags = await resolveFeatureFlags(ctx.userId);

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
        const resolved = await resolveTodosForGmailSource({
          userId: ctx.userId,
          sourceThreadId,
          // Stored as `resolved_reason`.
          reason: ctx.state.reason,
          actor: "system",
          // Never `open`: the user accepted it, and a holding reply is not closure.
          statuses: ["suggested"],
        });

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
  let flags: Awaited<ReturnType<typeof resolveFeatureFlags>>;

  try {
    flags = await resolveFeatureFlags(ctx.userId);
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

  // `ctx.log` is an outbox insert on the same pool `open` uses, so a pool fault can
  // fail it too. A log fault must not escape: it falls back to the process log, with
  // the open fault as its allowlisted diagnostic. Item 58 moves this into the executor.
  const log = async (message: string, openErr?: unknown) => {
    try {
      await ctx.log(message);
    } catch (logErr) {
      logger.warn(
        {
          err: logErr,
          ...(openErr === undefined ? {} : { openError: safeErrorDiagnostic(openErr) }),
          event: "triage_document_ask_log_fault",
          runId: ctx.runId,
          sourceMessageId: documentAsk.source.messageId,
          retries: ctx.state.documentAskOpenRetries ?? 0,
        },
        "triage: document-ask step log failed",
      );
    }
  };

  try {
    // Idempotent per source message, so a deferred re-entry is safe.
    const opened = await documentAskReducer.open({
      userId: ctx.userId,
      source: documentAsk.source,
      proposal: documentAsk.proposal,
      observedAt: new Date(),
    });

    if (opened.kind === "noop") await log(`document_ask: open noop reason=${opened.reason}`);

    return next;
  } catch (err) {
    const retries = ctx.state.documentAskOpenRetries ?? 0;
    const delay = DOCUMENT_ASK_OPEN_RETRY_DELAYS_MS[retries];
    // Bounded so the line stays under the progress-message cap.
    const reason = toMessage(err).slice(0, 500);

    if (delay === undefined) {
      await log(`document_ask: open failed after ${retries} retries; ask lost: ${reason}`, err);

      return next;
    }

    await log(`document_ask: open failed (retry ${retries + 1}): ${reason}`, err);

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
    const accessToken = await getFreshAccessToken(ctxData.credentialId);

    const message = await getMessage({
      accessToken,
      id: ctxData.document.sourceId,
      format: "minimal",
    });

    const labelIds = message.labelIds ?? [];

    return isSentGmailMetadata({ labelIds })
      ? { kind: "sent", source: "live", labelIds }
      : { kind: "not-sent" };
  } catch (err) {
    if (isHttpError(err) && err.status === 404) return { kind: "missing" };
    throw err;
  }
}

/** The IO for `assembleObservations` (ADR-0051 §4a). Every read is best-effort. */
async function gatherObservations(args: {
  userId: string;
  documentId: string;
  sourceThreadId: string;
  document: { title: string | null; content: string; metadata: GmailDocumentMetadata };
  /** Scopes a per-account standing instruction. */
  accountId: string | null;
  persona: AccountPersona | null;
  senderContext: SenderContext;
  senderAddress: string | null;
}): Promise<Observations> {
  const meta = args.document.metadata;
  const labelIds = meta.labelIds ?? [];

  const isHumanSender = args.senderContext.effectiveAuthor === "person";

  const [thread, senderKindEnabled, standing, userContext] = await Promise.all([
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
    triageSenderKindProjectionEnabled(args.userId).catch(() => false),
    // This sender's standing instruction, read before the model call. A blip
    // reads as "none" and sets `readFailed`, so the trace can tell none from unknown.
    listActiveSuppressionInstructions(args.userId)
      .then((all) => {
        const match = findSenderSuppression(all, {
          senderEmail: args.senderAddress ?? meta.from ?? null,
          accountId: args.accountId,
          effect: "deprioritize_triage_category",
        });

        return {
          instruction: match
            ? {
                factId: match.factId,
                directive: match.value.directive,
                phrasing: match.value.phrasing,
              }
            : null,
          readFailed: false,
        };
      })
      .catch(() => ({ instruction: null, readFailed: true })),
    // Cold-start prior (ADR-0050 D1). One point read, never a memory search (#435).
    // A flag, because null alone cannot tell a failure from no chunk.
    readUserContextLine(args.userId)
      .then((line) => ({ line, readFailed: false }))
      .catch(() => ({ line: null, readFailed: true })),
  ]);

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

  const [knownContact, relationship] = await Promise.all([
    usePersonTreatment && args.senderAddress
      ? isKnownContact(args.userId, args.senderAddress).catch(() => false)
      : Promise.resolve(false),
    resolveSenderRelationship({
      userId: args.userId,
      senderAddress: args.senderAddress,
      isHumanSender: usePersonTreatment,
      // A throw reads as "not cold": keep the todo rather than over-suppress.
    }).catch(() => RELATIONSHIP_READ_FAILED),
  ]);

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

  return assembleObservations({
    senderKey,
    senderPrior,
    persona: args.persona,
    thread,
    knownContact,
    senderRelationship: relationship.descriptor,
    senderRelationshipIsCold: relationship.isColdContact,
    senderKind,
    standingInstruction: standing.instruction,
    standingInstructionReadFailed: standing.readFailed,
    userContext: userContext.line,
    userContextReadFailed: userContext.readFailed,
    labelIds,
    signalText,
  });
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
