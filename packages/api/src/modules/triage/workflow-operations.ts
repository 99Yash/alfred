import { publishEvent } from "../../events/publish.js";
import { resolveFeatureFlags } from "../features/flags.js";
import { getSenderSignificance } from "../memory/significance.js";
import { findActiveSenderSuppression } from "../memory/standing-instructions.js";
import { suggestTodo } from "../todos/suggest.js";
import {
  classifyEmail,
  DEFAULT_TRIAGE_CATEGORY,
  resolveTodoSuggestion,
  todoSuppressionReason,
  type ClassifyAudit,
  type TriageClassification,
} from "./classify.js";
import { isKnownContact } from "./contacts.js";
import { extractSenderContext } from "./sender-context.js";
import { senderExtractionEvent } from "./sender-extraction-event.js";
import { resolveSenderKind, triageSenderKindProjectionEnabled } from "./sender-kind.js";
import { resolveSenderRelationship } from "./sender-relationship.js";
import {
  getSenderPrior,
  incrementSenderPrior,
  senderKeyFor,
  senderPriorWriteKeyFor,
} from "./sender-priors.js";
import { isSentGmailMetadata } from "./sent-mail.js";
import {
  getDocumentAuthoredAt,
  getTriage,
  loadTriageContext,
  markGmailDocumentSent,
  upsertTriage,
  type TriageDocumentContext,
} from "./store.js";
import { reconcileThreadLabel } from "./tags.js";
import { getThreadState } from "./thread-state.js";
import { assembleObservations, type Observations } from "./observations.js";
import type { StepContext, StepResult } from "../agent/index.js";
import {
  gmailTodoSources,
  isHttpError,
  toStringArray,
  type AccountPersona,
  type SenderContext,
  toMessage,
} from "@alfred/contracts";
import { getFreshAccessToken, getMessage, type TriageCategory } from "@alfred/integrations/google";

/**
 * Email triage workflow (ADR-0025 #1).
 *
 * Steps:
 *   1. classify    — load doc + credential, extract SenderContext, gather
 *                    deterministic observations (sender prior, persona, thread
 *                    state, known-contact, Gmail signals, content flags), run
 *                    the context-rich cheap classifier (which owns the
 *                    conditional second cheap pass + override floor, ADR-0051),
 *                    then upsert the final `email_triage` row keyed on the
 *                    Gmail thread. No boss `deepen` escalation.
 *   2. apply-label — modify Gmail labels (add chosen on the latest message,
 *                    strip alfred labels from every sibling message in the
 *                    thread), persist `applied_label_id`. Done.
 *
 * Schema model:
 *   One `email_triage` row per (userId, sourceThreadId). New messages in an
 *   auto-tagged thread re-run classify and overwrite the row; user-overridden
 *   tags stay pinned. No per-message audit row; audit lives on `api_call_log`
 *   (the metered LLM call) + `agent_runs`.
 *
 * Idempotency:
 *   - The classify step skips the LLM if the thread's existing triage row
 *     was written by THIS run (a retry within the same attempt reuses the
 *     prior call).
 *   - A NEW run on a thread always re-classifies — that's the explicit
 *     re-evaluation contract for replies (ADR-0025: "Re-evaluates on reply").
 *   - The apply-label step is naturally idempotent: Gmail's `messages.modify`
 *     adds/removes labels deterministically.
 *
 * Thread-level label collapse:
 *   Gmail's thread view unions labels across every message in a thread, so
 *   an older `fyi`/`follow_up` message left next to a newer `done` reply
 *   ends up showing both tags. `apply-label` queries the thread on Gmail's
 *   side (`getThreadMessageLabels`) and strips every alfred label off every
 *   sibling message before applying the new label to the latest one.
 *
 * Failure modes:
 *   - LLM parse failure: caught, falls through to DEFAULT_TRIAGE_CATEGORY
 *     with confidence=0.5; we never leave a message untriaged.
 *   - Credential gone (user disconnected mid-run): the load step throws,
 *     the run goes to `failed`, no Gmail label written.
 *   - Gmail API failure on label-write: bubbles up, the runtime retries
 *     the step. The `email_triage` row is already written so no LLM cost
 *     repeats.
 *   - Document has no `sourceThreadId` (shouldn't happen for Gmail, but
 *     defensive): finish without writing — we have nothing to key on.
 */

export interface EmailTriageOperationState {
  documentId: string;
  reason?: "ingest" | "webhook" | "manual" | "reply";
  sourceThreadId?: string;
  category?: TriageCategory;
  confidence?: number;
  rationale?: string | null;
  senderContext?: SenderContext;
  force?: boolean;
}

export async function runEmailTriageClassify<State extends EmailTriageOperationState>(
  ctx: StepContext<State>,
): Promise<StepResult<State>> {
  // Background-agent toggles (Settings → Features). Tagging gates the
  // Gmail label (apply-label step); action-items gates the todo
  // suggestion below. Both share this one classify call. When the user
  // has switched BOTH off there's nothing to produce — skip before the
  // document load + cheap-model call so a disabled inbox costs nothing.
  const flags = await resolveFeatureFlags(ctx.userId);
  if (!flags.emailTagging && !flags.actionItems) {
    await ctx.log(`classify: skipped reason=triage-disabled (tagging + action-items off)`);
    return {
      kind: "done",
      state: ctx.state,
      output: { skipped: true, reason: "triage-disabled" },
    };
  }

  const ctxData = await loadTriageContext(ctx.state.documentId, ctx.userId);
  if (!ctxData) {
    // Document was deleted between enqueue and run — unrecoverable
    // but not an error. Mark done; upstream callers can detect via
    // `output.skipped`.
    await ctx.log(`document gone: ${ctx.state.documentId}`);
    return {
      kind: "done",
      state: ctx.state,
      output: { skipped: true, reason: "document-not-found" },
    };
  }

  const sourceThreadId = ctxData.document.sourceThreadId;
  if (!sourceThreadId) {
    // Gmail messages always carry a threadId — but be defensive so
    // a malformed ingest doesn't crash the worker.
    await ctx.log(`document missing sourceThreadId: ${ctx.state.documentId}`);
    return {
      kind: "done",
      state: ctx.state,
      output: { skipped: true, reason: "missing-thread-id" },
    };
  }

  // Sent-doc guard (ADR-0051 #7, defense-in-depth — issue #306). The
  // upstream fan-out excludes docs whose stored metadata already carries
  // `SENT`, but Gmail can attach that label after our first insert. When
  // the stored row is still ambiguous, verify the live minimal Gmail
  // message before allowing classify.
  const sentStatus = await sentDocumentStatusAtClassifyTime(ctxData);
  if (sentStatus.kind === "missing") {
    await ctx.log(
      `classify: doc=${ctx.state.documentId} source message missing in Gmail — skipping`,
    );
    return {
      kind: "done",
      state: ctx.state,
      output: { skipped: true, reason: "source-message-not-found" },
    };
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
    return {
      kind: "done",
      state: ctx.state,
      output: { skipped: true, reason: "sent-document" },
    };
  }

  const senderContextResult = extractSenderContext({
    fromHeader: metadataString(ctxData.document.metadata, "from"),
    subject: ctxData.document.title,
    body: ctxData.document.content,
  });
  const senderContext = senderContextResult.context;

  // Idempotency: if the thread's row was written by THIS run already,
  // reuse the prior classification — a retry within the same attempt
  // shouldn't re-bill the LLM. A fresh run from a reply trigger writes
  // a new run_id and so will re-classify.
  const existing = await getTriage(ctx.userId, sourceThreadId);

  // Already-tagged guard (ADR-0025 refinement). The thread re-classifies
  // on a reply — but only on a genuinely NEWER message. A thread that
  // already carries an applied Gmail label is skipped when the incoming
  // message is provably not newer than the one we tagged from:
  // re-delivered pub/sub pushes, out-of-order ingestion, and the same
  // message picked up by a second ingestion source all land here and
  // exit without burning a classify call or rewriting the Gmail label.
  //
  // We skip ONLY when (a) a label is actually applied and (b) we can
  // prove ordering from both timestamps. If either `authored_at` is
  // missing we can't order the messages, so we fall through and
  // re-classify — missing a real reply is worse than an extra classify.
  // A retry within the SAME run is handled below (reuse, never skip).
  if (existing && existing.runId !== ctx.runId && existing.appliedLabelId && !ctx.state.force) {
    const incomingAuthoredAt = ctxData.document.authoredAt;
    const priorAuthoredAt = existing.documentId
      ? await getDocumentAuthoredAt(ctx.userId, existing.documentId)
      : null;
    // Equal timestamps are NOT proof of duplication: Gmail Date headers
    // are second-granular and distinct messages can share an authoredAt.
    // A strictly-older message is provably not newer; an equal-timestamp
    // message only counts as "not newer" when it's the SAME document we
    // already tagged (re-delivered push / second ingestion source). A
    // genuine reply in the same second is a different documentId and must
    // re-classify.
    const isSameStoredDocument = existing.documentId === ctx.state.documentId;
    const provablyNotNewer =
      // The same stored document is by definition not newer than itself, so
      // a re-delivered push / second ingestion source skips regardless of
      // whether either `authored_at` is present (a missing timestamp would
      // otherwise fall through to a wasted re-classify + stray prior bump).
      isSameStoredDocument ||
      (incomingAuthoredAt != null &&
        priorAuthoredAt != null &&
        incomingAuthoredAt.getTime() < priorAuthoredAt.getTime());
    if (provablyNotNewer) {
      await ctx.log(
        `classify: thread=${sourceThreadId} already tagged (${existing.category}); ` +
          `doc=${ctx.state.documentId} not newer than prior message — skipping re-process`,
      );
      return {
        kind: "done",
        state: ctx.state,
        output: {
          skipped: true,
          reason: "thread-already-tagged",
          category: existing.category,
        },
      };
    }
  }

  let classification: TriageClassification;
  let model: string;
  let audit: ClassifyAudit | null = null;
  let observations: Awaited<ReturnType<typeof gatherObservations>> | null = null;
  // Whether the canonical triage row is owned by this run. True on the
  // reuse path, and on the new path once the recency-guarded upsert lands.
  // Gates the post-classification side effects (hoisted below the if/else
  // so they run on BOTH paths — see #157).
  let written = false;
  let todoSuggestion: ReturnType<typeof resolveTodoSuggestion> = null;
  let standingSuppression: Awaited<ReturnType<typeof findActiveSenderSuppression>> = null;
  let standingSuppressionReadFailed = false;
  let standingSuppressionReadError: string | null = null;
  const resolveTodoAndStandingSuppression = async () => {
    const nextTodoSuggestion = resolveTodoSuggestion(classification, ctxData.document.authoredAt);
    let nextStandingSuppression: Awaited<ReturnType<typeof findActiveSenderSuppression>> = null;
    let nextStandingSuppressionReadFailed = false;
    let nextStandingSuppressionReadError: string | null = null;
    if (nextTodoSuggestion) {
      try {
        nextStandingSuppression = await findActiveSenderSuppression(ctx.userId, {
          senderEmail:
            senderContextResult.senderAddress ?? metadataString(ctxData.document.metadata, "from"),
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
    };
  };
  const reusedExistingRow = Boolean(existing && existing.runId === ctx.runId);
  if (reusedExistingRow && existing) {
    classification = {
      category: existing.category,
      confidence: existing.confidence,
      rationale: existing.rationale ?? "",
      // Reconstruct the todo proposal + rubric trace from the persisted
      // columns so `resolveTodoSuggestion` below behaves identically to
      // the first attempt — without these the reuse path silently dropped
      // the classifier-minted todo (#157). `?? undefined` because the
      // classification fields are optional (a null stored value means the
      // model proposed no todo).
      todoSuggestion: existing.todoSuggestion ?? undefined,
      todoDecision: existing.todoDecision ?? undefined,
    };
    model = existing.model;
    // The row is already owned by this run, so its tag is canonical —
    // mark it written so the side effects below still fire. A prior
    // attempt of THIS run can commit the row then die before suggestTodo
    // (stale-lease reclaim re-enters classify with the same runId), which
    // would otherwise permanently drop the classifier-minted todo (#157).
    written = true;
    ({
      todoSuggestion,
      standingSuppression,
      standingSuppressionReadFailed,
      standingSuppressionReadError,
    } = await resolveTodoAndStandingSuppression());
    await ctx.log(`classify: reuse existing thread row category=${classification.category}`);
  } else {
    // Gather deterministic observations (ADR-0051 §4a) before the model
    // call. All reads are best-effort context; built before the try so
    // they're available for the decision trace on the fallback path too.
    // Sender priors are read for bulk/service senders only
    // (`senderKeyFor` returns null for humans); known-contact is the
    // human-sender mirror (skip for bots/services — priors cover them).
    observations = await gatherObservations({
      userId: ctx.userId,
      documentId: ctx.state.documentId,
      sourceThreadId,
      document: ctxData.document,
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
      // LLM parse / network failure → default category. Better to
      // ship a low-confidence label than block the message entirely.
      // Persist the exception text in `rationale` so the row itself
      // tells us why classification fell through — progress events are not
      // the queryable triage record. `model="fallback"` is non-learnable
      // (senderPriorWriteKeyFor skips it).
      const errMsg = toMessage(err);
      await ctx.log(`classify failed; falling through to default: ${errMsg}`);
      classification = {
        category: DEFAULT_TRIAGE_CATEGORY,
        confidence: 0.5,
        rationale: `Classifier failed; default applied. err=${errMsg.slice(0, 500)}`,
      };
      model = "fallback";
    }

    // Sender significance for the rail's presentation-layer demotion
    // (ADR-0064). Read the precomputed scalar once and stash its band on
    // the row — best-effort, null on any miss (non-human/unscored/no row),
    // which the rail scorer treats as neutral. Never blocks classify.
    const senderSignificance = await getSenderSignificance(
      ctx.userId,
      senderContextResult.senderAddress,
    ).catch(() => null);

    // Resolve the todo/suppression fields before the row write so the
    // durable trace persisted with the row contains the same suppression
    // facts the side-effect branch below consumes. Logging any read
    // failure is deferred until after the row+trace transaction commits.
    ({
      todoSuggestion,
      standingSuppression,
      standingSuppressionReadFailed,
      standingSuppressionReadError,
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

    // Recency-guarded, advisory-locked upsert. `written` is false when a
    // concurrent run for a strictly-newer message already owns the row —
    // this run lost the race, so it skips the side effects below (they'd
    // emit signals for a tag that isn't canonical). If this run does win,
    // the decision trace is written in the same transaction as the row so
    // a crash after the row write cannot leave a tag without its "why".
    // The apply-label step converges on the row's canonical message
    // regardless.
    const upserted = await upsertTriage({
      userId: ctx.userId,
      sourceThreadId,
      documentId: ctx.state.documentId,
      category: classification.category,
      confidence: classification.confidence,
      rationale: classification.rationale,
      model,
      runId: ctx.runId,
      // Persist the todo proposal + rubric trace so a same-run retry on
      // the reuse path can re-mint a todo this attempt is about to (#157).
      todoSuggestion: classification.todoSuggestion ?? null,
      todoDecision: classification.todoDecision ?? null,
      senderSignificanceBand: senderSignificance?.band ?? null,
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

  // Post-classification side effects, hoisted out of the new-classification
  // branch so they also run when classify is re-entered on the reuse path
  // (a stale-lease reclaim that committed the row but died before getting
  // here, #157). All are `written`-gated and either idempotent or
  // self-healing, so re-running them on a reuse re-attempt is safe.

  // Tell the rail to re-fetch: the row's category chip just changed.
  // Best-effort and intentionally outside `upsertTriage`'s implicit
  // `db()` connection — the store doesn't take a `tx` arg, so the publish
  // can't share one. The 5-min rail poll recovers a dropped frame, and a
  // server crash between the two writes still leaves a triaged row to be
  // picked up on the next poll. If publish itself throws, we log and
  // continue so a transient outbox issue doesn't fail the workflow step.
  if (written) {
    try {
      await publishEvent({
        userId: ctx.userId,
        kind: "inbox.updated",
        payload: { reason: "triaged", count: 1 },
      });
    } catch (err) {
      await ctx.log(`inbox.updated publish failed: ${toMessage(err)}`);
    }
  }

  if (standingSuppressionReadError) {
    await ctx.log(
      `standing_instruction: read failed for block_todo_suggestion (suppressing todo): ${standingSuppressionReadError}`,
    );
  }

  // Sender-prior histogram write-back (ADR-0051 #2, Phase 2). Learns
  // ONLY from Alfred's own classifications and only for bulk senders:
  // skip human senders (`senderKeyFor` returns null) and the user's own
  // sent mail (defensive — sent docs are excluded from the triage
  // fan-out upstream, so this branch shouldn't see them). Skip fallback
  // labels too: an outage/default category is not a learning signal.
  // Best-effort: a prior write must never fail the label, which is the
  // contract. NEW-PATH ONLY: `incrementSenderPrior` is a non-idempotent
  // histogram bump, so a reuse re-attempt must not double-count — only
  // the originating classification teaches it. The outbound-reply re-eval
  // (issue #282, `reason: "reply"`) re-classifies the same inbound doc to
  // refresh the thread tag after the user replies; it is NOT a fresh
  // observation, so it must not re-bump the sender prior either.
  if (!reusedExistingRow && written && ctx.state.reason !== "reply") {
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
          displayName: metadataString(ctxData.document.metadata, "from"),
        });
      } catch (err) {
        await ctx.log(`sender_prior write failed (non-fatal): ${toMessage(err)}`);
      }
    }
  }

  // Real-time todo suggestion (ADR-0050 amendment 2026-06-05). The cheap
  // classifier emits `todoSuggestion` when this mail is an actionable,
  // context-complete commitment (rule 16); the tail step mints a
  // `suggested` todo for the rail. `todoSuggestion` rides the final
  // classification (the second cheap pass re-emits it; the override floor
  // preserves it). The category gate is the floor against a stray
  // suggestion. `suggest_todo` is idempotent on source overlap, so a
  // re-triaged thread (or a reuse re-attempt) merges rather than
  // duplicates, and a failed suggestion is non-fatal — the label + row
  // are the contract. On the reuse path `classification` is reconstructed
  // from the stored row, which carries the same `todoSuggestion`.
  // `todoSuggestion` was resolved before the row write, using the email's
  // send time so relative deadlines ("due tomorrow") resolve to an
  // absolute date instead of going stale on the rail.
  // Structural disqualifier (the cheap model won't reliably self-apply it):
  // a GitHub PR-review thread with nothing live at stake, or Alfred's own
  // HIL approval mail, mints no rail todo even when the model proposed one.
  const suppression = todoSuggestion
    ? todoSuppressionReason({
        sender: metadataString(ctxData.document.metadata, "from"),
        subject: ctxData.document.title,
        signalText: [
          ctxData.document.title,
          ctxData.document.content,
          metadataString(ctxData.document.metadata, "snippet"),
        ]
          .filter(Boolean)
          .join("\n"),
      })
    : null;
  // `written` gate: only the run that owns the canonical row proposes a
  // todo, so a superseded older message can't mint a stray suggestion.
  // `flags.actionItems` gate: the user can switch off action-item
  // suggestions while keeping email tagging on (they share this classify).
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
        // Thread ref always; plus a stable real-world `loop` ref when the
        // subject/sender resolve one, so a recurring tracker/PR/issue loop
        // that re-notifies on a new thread each time collapses onto this
        // one todo instead of re-minting (#355).
        sources: gmailTodoSources({
          threadId: sourceThreadId,
          subject: ctxData.document.title,
          sender: metadataString(ctxData.document.metadata, "from"),
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
      category: classification.category as TriageCategory,
      confidence: classification.confidence,
      rationale: classification.rationale,
      senderContext,
    },
    nextStep: "apply-label",
  };
}

export async function runEmailTriageApplyLabel<State extends EmailTriageOperationState>(
  ctx: StepContext<State>,
): Promise<StepResult<State>> {
  const category = ctx.state.category;
  const sourceThreadId = ctx.state.sourceThreadId;
  if (!category || !sourceThreadId) {
    throw new Error(
      "[email-triage] apply-label entered without category/sourceThreadId; classify step did not commit",
    );
  }

  // Email-tagging toggle (Settings → Features). When off, Alfred keeps
  // the in-app triage row (drives the inbox chips + any action-item it
  // already minted) but does not touch the user's Gmail labels.
  const flags = await resolveFeatureFlags(ctx.userId);
  if (!flags.emailTagging) {
    await ctx.log(`apply-label: skipped reason=tagging-disabled`);
    return {
      kind: "done",
      state: ctx.state,
      output: { category, applied: false, reason: "tagging-disabled" },
    };
  }

  const outcome = await reconcileThreadLabel({
    userId: ctx.userId,
    sourceThreadId,
    fallbackDocumentId: ctx.state.documentId,
  });

  if (!outcome.applied) {
    await ctx.log(`apply-label: skipped reason=${outcome.reason}`);
    return {
      kind: "done",
      state: ctx.state,
      output: {
        category: outcome.category ?? category,
        applied: false,
        reason: outcome.reason,
      },
    };
  }

  await ctx.log(
    `apply-label: doc=${ctx.state.documentId} canonical=${outcome.targetDocId} ` +
      `thread=${sourceThreadId} applied=${outcome.category} (${outcome.appliedLabelId}) ` +
      `removed=${outcome.removedLabelIds.length} ` +
      `siblingsStripped=${outcome.strippedSiblings.length}/${outcome.siblingCount}`,
  );

  return {
    kind: "done",
    state: ctx.state,
    output: {
      category: outcome.category,
      confidence: ctx.state.confidence,
      applied: true,
      appliedLabelId: outcome.appliedLabelId,
      removedLabelIds: outcome.removedLabelIds,
      strippedSiblings: outcome.strippedSiblings.length,
    },
  };
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

type SentDocumentStatus =
  | { kind: "not-sent" }
  | { kind: "missing" }
  | { kind: "sent"; source: "stored" }
  | { kind: "sent"; source: "live"; labelIds: readonly string[] };

async function sentDocumentStatusAtClassifyTime(
  ctxData: TriageDocumentContext,
): Promise<SentDocumentStatus> {
  if (isSentGmailMetadata(ctxData.document.metadata)) return { kind: "sent", source: "stored" };

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

/**
 * Assemble the deterministic observation object fed to the classifier
 * (ADR-0051 §4a). Owns the IO — sender-prior read (bulk/service senders only),
 * thread state, known-contact (human senders only), persona pass-through — then
 * delegates to the pure `assembleObservations`. Every read is best-effort: a
 * blip yields the empty/false default rather than failing the classify.
 */
async function gatherObservations(args: {
  userId: string;
  documentId: string;
  sourceThreadId: string;
  document: { title: string | null; content: string; metadata: Record<string, unknown> };
  persona: AccountPersona | null;
  senderContext: SenderContext;
  senderAddress: string | null;
}): Promise<Observations> {
  const meta = args.document.metadata;
  const labelIds = toStringArray(meta.labelIds);

  // Read key uses the same derivation as the write key (humans → null) but no
  // sent/fallback guard: reads are harmless and the classify step only runs on
  // received mail anyway.
  const isHumanSender = args.senderContext.effectiveAuthor === "person";
  const [thread, senderKindEnabled] = await Promise.all([
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
  const [knownContact, senderRelationship] = await Promise.all([
    usePersonTreatment && args.senderAddress
      ? isKnownContact(args.userId, args.senderAddress).catch(() => false)
      : Promise.resolve(false),
    resolveSenderRelationship({
      userId: args.userId,
      senderAddress: args.senderAddress,
      isHumanSender: usePersonTreatment,
    }).catch(() => null),
  ]);

  const signalText = [
    metadataString(meta, "from"),
    metadataString(meta, "to"),
    metadataString(meta, "cc"),
    metadataString(meta, "snippet"),
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
    senderRelationship,
    senderKind,
    labelIds,
    signalText,
  });
}
