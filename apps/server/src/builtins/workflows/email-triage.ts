import {
  classifyEmail,
  clearAppliedLabelIds,
  DEFAULT_TRIAGE_CATEGORY,
  getThreadSiblingsWithLabels,
  getTriage,
  loadTriageContext,
  setAppliedLabelId,
  triageWorkflowInputSchema,
  TRIAGE_WORKFLOW_SLUG,
  upsertTriage,
  type TriageClassification,
  type Workflow,
} from "@alfred/api";
import {
  applyTriageLabel,
  TRIAGE_CATEGORIES,
  type TriageCategory,
} from "@alfred/integrations/google";
import { z } from "zod";

/**
 * Email triage workflow (ADR-0025 #1).
 *
 * Steps:
 *   1. classify    — load doc + credential, call cheap-tier LLM, write
 *                    `email_triage` row.
 *   2. apply-label — modify Gmail labels (add chosen, remove previous),
 *                    persist `applied_label_id`. Done.
 *
 * Idempotency:
 *   - The classify step skips the LLM if a triage row from the SAME run
 *     already exists (a retry within the same run reuses the prior call).
 *   - A NEW run always re-classifies — that's the explicit re-evaluation
 *     contract for replies (ADR-0025: "Re-evaluates on reply").
 *   - The apply-label step is naturally idempotent: Gmail's `messages.modify`
 *     adds/removes labels deterministically.
 *
 * Failure modes:
 *   - LLM parse failure: caught, falls through to DEFAULT_TRIAGE_CATEGORY
 *     with confidence=0.5; we never leave a message untriaged.
 *   - Credential gone (user disconnected mid-run): the load step throws,
 *     the run goes to `failed`, no Gmail label written.
 *   - Gmail API failure on label-write: bubbles up, the runtime retries
 *     the step. The `email_triage` row is already written so no LLM cost
 *     repeats.
 */

const TRIAGE_CATEGORIES_SCHEMA = z.enum(TRIAGE_CATEGORIES);

const stateSchema = z.object({
  documentId: z.string(),
  reason: z.enum(["ingest", "webhook", "manual", "reply"]).optional(),
  /** Set after classify; consumed by apply-label. */
  category: TRIAGE_CATEGORIES_SCHEMA.optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().nullable().optional(),
  /** Previously-applied alfred label id (re-classification path). */
  previousLabelId: z.string().nullable().optional(),
});
type State = z.infer<typeof stateSchema>;

export const emailTriageWorkflow: Workflow<State> = {
  slug: TRIAGE_WORKFLOW_SLUG,
  name: "Email triage",
  description:
    "Classify an inbound Gmail message into one of ten categories and write the corresponding label back (ADR-0025).",
  // Fan-out is driven by `gmail.poll_history` per fresh-inserted doc
  // (packages/api/src/modules/integrations/queue.ts). Declared as an
  // event-source trigger so the workflows.tick cron path never touches
  // it.
  trigger: { kind: "event", source: "gmail.poll_history" },
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

        // Idempotency: if a row from THIS run already exists, reuse the
        // prior classification — a retry within the same attempt shouldn't
        // re-bill the LLM. A fresh run from a reply trigger writes a new
        // run_id and so will re-classify.
        const existing = await getTriage(ctx.state.documentId);
        let classification: TriageClassification;
        let model: string;
        if (existing && existing.runId === ctx.runId) {
          classification = {
            category: existing.category,
            confidence: existing.confidence,
            rationale: existing.rationale ?? "",
          };
          model = existing.model;
          await ctx.log(`classify: reuse existing row category=${classification.category}`);
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

          await upsertTriage({
            documentId: ctx.state.documentId,
            userId: ctx.userId,
            category: classification.category,
            confidence: classification.confidence,
            rationale: classification.rationale,
            model,
            runId: ctx.runId,
          });
        }

        await ctx.log(
          `classify: doc=${ctx.state.documentId} category=${classification.category} ` +
            `confidence=${classification.confidence.toFixed(2)} model=${model}`,
        );

        return {
          kind: "next",
          state: {
            ...ctx.state,
            category: classification.category as TriageCategory,
            confidence: classification.confidence,
            rationale: classification.rationale,
            previousLabelId: existing?.appliedLabelId ?? null,
          },
          nextStep: "apply-label",
        };
      },
    },

    "apply-label": {
      id: "apply-label",
      async run(ctx) {
        const category = ctx.state.category;
        if (!category) {
          throw new Error(
            "[email-triage] apply-label entered without a category set; classify step did not commit",
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

        // Gmail aggregates labels at the thread level (a thread shows the
        // union of every message's labels). If an older message in this
        // thread still carries its earlier alfred label, the thread ends
        // up tagged with multiple categories. Strip those siblings here
        // so the latest classification wins.
        const siblings = ctxData.document.sourceThreadId
          ? await getThreadSiblingsWithLabels({
              documentId: ctx.state.documentId,
              userId: ctx.userId,
              sourceThreadId: ctxData.document.sourceThreadId,
            })
          : [];

        const result = await applyTriageLabel({
          credentialId: ctxData.credentialId,
          messageId: ctxData.document.sourceId,
          category,
          previousLabelId: ctx.state.previousLabelId ?? undefined,
          threadSiblings: siblings.map((s) => ({
            messageId: s.sourceId,
            labelId: s.appliedLabelId,
          })),
        });

        await setAppliedLabelId(ctx.state.documentId, result.appliedLabelId);
        if (result.strippedSiblings.length) {
          // Resolve stripped Gmail message ids back to their document ids so
          // we can clear `applied_label_id` on the corresponding triage rows.
          const strippedMessageIds = new Set(result.strippedSiblings.map((s) => s.messageId));
          const strippedDocIds = siblings
            .filter((s) => strippedMessageIds.has(s.sourceId))
            .map((s) => s.documentId);
          await clearAppliedLabelIds(strippedDocIds);
        }
        await ctx.log(
          `apply-label: doc=${ctx.state.documentId} applied=${category} (${result.appliedLabelId}) ` +
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
