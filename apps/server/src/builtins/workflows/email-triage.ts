import {
  classifyEmail,
  deepenTriageClassification,
  DEFAULT_TRIAGE_CATEGORY,
  extractSenderContext,
  getDocumentAuthoredAt,
  getTriage,
  loadTriageContext,
  publishEvent,
  readTriageUserContext,
  setAppliedLabelId,
  shouldDeepen,
  triageWorkflowInputSchema,
  TRIAGE_WORKFLOW_SLUG,
  upsertTriage,
  type DeepenDecision,
  type SenderContextResult,
  type TriageClassification,
  type Workflow,
} from "@alfred/api";
import { senderContextSchema, type SenderContext } from "@alfred/contracts";
import {
  applyTriageLabel,
  findThreadSiblingsWithAlfredLabels,
  TRIAGE_CATEGORIES,
  type TriageCategory,
} from "@alfred/integrations/google";
import { z } from "zod";

/**
 * Email triage workflow (ADR-0025 #1).
 *
 * Steps:
 *   1. classify    — load doc + credential, extract SenderContext, call
 *                    cheap-tier LLM, optionally run boss-tier `deepen` for
 *                    live severity-suspect bot alerts, then upsert the final
 *                    `email_triage` row keyed on the Gmail thread.
 *   2. apply-label — modify Gmail labels (add chosen on the latest message,
 *                    strip alfred labels from every sibling message in the
 *                    thread), persist `applied_label_id`. Done.
 *
 * Schema model:
 *   One `email_triage` row per (userId, sourceThreadId). Each new message in
 *   a thread re-runs classify and OVERWRITES the row — the canonical alfred
 *   tag is always the latest message's outcome. No per-message audit row;
 *   audit lives on `api_call_log` (the metered LLM call) + `agent_runs`.
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

const TRIAGE_CATEGORIES_SCHEMA = z.enum(TRIAGE_CATEGORIES);

const stateSchema = z.object({
  documentId: z.string(),
  reason: z.enum(["ingest", "webhook", "manual", "reply"]).optional(),
  /** Resolved from the document during classify; carried into apply-label. */
  sourceThreadId: z.string().optional(),
  /** Set after classify; consumed by apply-label. */
  category: TRIAGE_CATEGORIES_SCHEMA.optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().nullable().optional(),
  senderContext: senderContextSchema.optional(),
  deepenReason: z.enum(["severity_suspect_bot", "low_confidence", "unknown_human"]).optional(),
  deepenExecuted: z.boolean().optional(),
  shadowOnly: z.boolean().optional(),
});
type State = z.infer<typeof stateSchema>;

export const emailTriageWorkflow: Workflow<State> = {
  slug: TRIAGE_WORKFLOW_SLUG,
  name: "Email triage",
  description:
    "Classify an inbound Gmail message into one of ten categories and write the corresponding label back, keyed per-thread (ADR-0025).",
  // Fan-out is driven by the Gmail ingestion path per fresh-inserted doc
  // (packages/api/src/modules/integrations/queue.ts). Realtime traffic
  // arrives via `gmail.poll_recent` (pub/sub → messages.list, ADR-0037);
  // anything missed shows up on the 5-min `gmail.poll_history` catch-up
  // sweep. Declared as an event-source trigger so the workflows.tick
  // cron path never touches it.
  trigger: { kind: "event", source: "gmail", type: "message_received" },
  initialStep: "classify",
  stateSchema,

  initialState(input) {
    const parsed = triageWorkflowInputSchema.parse(input.input ?? {});
    return {
      documentId: parsed.documentId,
      reason: parsed.reason,
    };
  },

  steps: {
    classify: {
      id: "classify",
      async run(ctx) {
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
        if (existing && existing.runId !== ctx.runId && existing.appliedLabelId) {
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
            incomingAuthoredAt != null &&
            priorAuthoredAt != null &&
            (incomingAuthoredAt.getTime() < priorAuthoredAt.getTime() ||
              (incomingAuthoredAt.getTime() === priorAuthoredAt.getTime() && isSameStoredDocument));
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
        let cheapClassification: TriageClassification | null = null;
        let model: string;
        let deepenDecision: DeepenDecision = { mode: "skip" };
        let deepenExecuted = false;
        let shadowOnly = false;
        let severityFlag: "severe" | "normal" | "low" | null = null;
        let dossierRequested = false;
        let deepenFailure: string | null = null;
        if (existing && existing.runId === ctx.runId) {
          classification = {
            category: existing.category,
            confidence: existing.confidence,
            rationale: existing.rationale ?? "",
          };
          cheapClassification = classification;
          model = existing.model;
          await ctx.log(`classify: reuse existing thread row category=${classification.category}`);
        } else {
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
              runId: ctx.runId,
              stepId: "classify",
              idempotencyKey: ctx.idempotencyKey,
            });
            classification = result.classification;
            model = result.model;
          } catch (err) {
            // LLM parse / network failure → default category. Better to
            // ship a low-confidence label than block the message entirely.
            // Persist the exception text in `rationale` so the row itself
            // tells us why classification fell through — ctx.log only goes
            // to a transient event stream.
            const errMsg = err instanceof Error ? err.message : String(err);
            await ctx.log(`classify failed; falling through to default: ${errMsg}`);
            classification = {
              category: DEFAULT_TRIAGE_CATEGORY,
              confidence: 0.5,
              rationale: `Classifier failed; default applied. err=${errMsg.slice(0, 500)}`,
            };
            model = "fallback";
          }

          cheapClassification = classification;
          deepenDecision = shouldDeepen({
            classification,
            senderContext,
            senderAddress: senderContextResult.senderAddress,
          });
          shadowOnly = deepenDecision.mode === "shadow";

          if (deepenDecision.mode === "execute") {
            try {
              const userContext = await readTriageUserContext(ctx.userId);
              const deepened = await deepenTriageClassification({
                userId: ctx.userId,
                document: {
                  id: ctxData.document.id,
                  title: ctxData.document.title,
                  content: ctxData.document.content,
                  authoredAt: ctxData.document.authoredAt,
                  metadata: ctxData.document.metadata,
                },
                classification,
                senderContext,
                userContext,
                runId: ctx.runId,
                stepId: "deepen",
                attempt: ctx.attempt,
                idempotencyKey: `${ctx.idempotencyKey}:deepen`,
              });
              classification = deepened.classification;
              model = `${model}+deepen`;
              deepenExecuted = true;
              severityFlag = deepened.severityFlag;
              dossierRequested = Boolean(deepened.dossierRequest);
              if (deepened.dossierRequest) {
                await ctx.log(
                  `deepen: dossier request for ${deepened.dossierRequest.personEmail} deferred; ` +
                    `person-research cache/workflow is not present in this tree`,
                );
              }
            } catch (err) {
              deepenFailure = err instanceof Error ? err.message : String(err);
              await ctx.log(`deepen failed; keeping cheap classification: ${deepenFailure}`);
            }
          }

          await upsertTriage({
            userId: ctx.userId,
            sourceThreadId,
            documentId: ctx.state.documentId,
            category: classification.category,
            confidence: classification.confidence,
            rationale: classification.rationale,
            model,
            runId: ctx.runId,
          });

          // Tell the rail to re-fetch: the row's category chip just
          // changed. Best-effort and intentionally outside `upsertTriage`'s
          // implicit `db()` connection — the store doesn't take a `tx`
          // arg, so the publish can't share one. The 5-min rail poll
          // recovers a dropped frame, and a server crash between the
          // two writes still leaves a triaged row to be picked up on
          // the next poll. If publish itself throws, we log and continue
          // so a transient outbox issue doesn't fail the workflow step.
          try {
            await publishEvent({
              userId: ctx.userId,
              kind: "inbox.updated",
              payload: { reason: "triaged", count: 1 },
            });
          } catch (err) {
            await ctx.log(
              `inbox.updated publish failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        await ctx.log(
          `triage.sender_extraction ${JSON.stringify(
            senderExtractionEvent({
              senderContextResult,
              cheapClassification: cheapClassification ?? classification,
              classification,
              deepenDecision,
              deepenExecuted,
              shadowOnly,
              severityFlag,
              dossierRequested,
              deepenFailure,
            }),
          )}`,
        );

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
            deepenReason: deepenDecision.reason,
            deepenExecuted,
            shadowOnly,
          },
          nextStep: "apply-label",
        };
      },
    },

    "apply-label": {
      id: "apply-label",
      async run(ctx) {
        const category = ctx.state.category;
        const sourceThreadId = ctx.state.sourceThreadId;
        if (!category || !sourceThreadId) {
          throw new Error(
            "[email-triage] apply-label entered without category/sourceThreadId; classify step did not commit",
          );
        }

        const ctxData = await loadTriageContext(ctx.state.documentId, ctx.userId);
        if (!ctxData) {
          // Doc evaporated between classify and label — race condition; finish.
          await ctx.log(`apply-label: document gone, finishing without write`);
          return {
            kind: "done",
            state: ctx.state,
            output: { category, applied: false, reason: "document-not-found" },
          };
        }

        // Resolve siblings from Gmail (not the DB) — single source of truth
        // for "which messages in this thread carry alfred labels right now."
        // Survives stale DB state from older deployments and hand-labelling.
        const siblings = await findThreadSiblingsWithAlfredLabels({
          credentialId: ctxData.credentialId,
          threadId: sourceThreadId,
          excludeMessageId: ctxData.document.sourceId,
        });

        const result = await applyTriageLabel({
          credentialId: ctxData.credentialId,
          messageId: ctxData.document.sourceId,
          category,
          // Strip every other alfred label off the latest message too — handles
          // the case where it was hand-labelled before alfred touched it.
          stripAllAlfredLabels: true,
          threadSiblings: siblings,
        });

        await setAppliedLabelId(ctx.userId, sourceThreadId, result.appliedLabelId);

        await ctx.log(
          `apply-label: doc=${ctx.state.documentId} thread=${sourceThreadId} ` +
            `applied=${category} (${result.appliedLabelId}) ` +
            `removed=${result.removedLabelIds.length} ` +
            `siblingsStripped=${result.strippedSiblings.length}/${siblings.length}`,
        );

        return {
          kind: "done",
          state: ctx.state,
          output: {
            category,
            confidence: ctx.state.confidence,
            applied: true,
            appliedLabelId: result.appliedLabelId,
            removedLabelIds: result.removedLabelIds,
            strippedSiblings: result.strippedSiblings.length,
          },
        };
      },
    },
  },
};

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function senderExtractionEvent(args: {
  senderContextResult: SenderContextResult;
  cheapClassification: TriageClassification;
  classification: TriageClassification;
  deepenDecision: DeepenDecision;
  deepenExecuted: boolean;
  shadowOnly: boolean;
  severityFlag: "severe" | "normal" | "low" | null;
  dossierRequested: boolean;
  deepenFailure: string | null;
}): {
  fromKind: SenderContext["fromKind"];
  bodyActor: SenderContext["bodyActor"] | null;
  effectiveAuthor: SenderContext["effectiveAuthor"];
  botSlug: SenderContext["botSlug"] | null;
  parserHit: SenderContextResult["parserHit"];
  senderAddress: string | null;
  senderDomain: string | null;
  classifierConfidence: number;
  classifierCategory: TriageCategory;
  wouldDeepen: boolean;
  wouldDeepenReason: DeepenDecision["reason"] | null;
  deepenExecuted: boolean;
  shadowOnly: boolean;
  severityFlag: "severe" | "normal" | "low" | null;
  refinedCategory: TriageCategory | null;
  dossierRequested: boolean;
  deepenFailure: string | null;
} {
  const { context } = args.senderContextResult;
  return {
    fromKind: context.fromKind,
    bodyActor: context.bodyActor ?? null,
    effectiveAuthor: context.effectiveAuthor,
    botSlug: context.botSlug ?? null,
    parserHit: args.senderContextResult.parserHit,
    senderAddress: args.senderContextResult.senderAddress,
    senderDomain: args.senderContextResult.senderDomain,
    classifierConfidence: args.cheapClassification.confidence,
    classifierCategory: args.cheapClassification.category,
    wouldDeepen: args.deepenDecision.mode !== "skip",
    wouldDeepenReason: args.deepenDecision.reason ?? null,
    deepenExecuted: args.deepenExecuted,
    shadowOnly: args.shadowOnly,
    severityFlag: args.severityFlag,
    refinedCategory: args.deepenExecuted ? args.classification.category : null,
    dossierRequested: args.dossierRequested,
    deepenFailure: args.deepenFailure,
  };
}
