import {
  assembleObservations,
  classifyEmail,
  DEFAULT_TRIAGE_CATEGORY,
  extractSenderContext,
  findActiveSenderSuppression,
  getDocumentAuthoredAt,
  getSenderPrior,
  getSenderSignificance,
  getThreadState,
  getTriage,
  incrementSenderPrior,
  isKnownContact,
  isSentGmailMetadata,
  loadTriageContext,
  publishEvent,
  reconcileThreadLabel,
  resolveFeatureFlags,
  resolveSenderRelationship,
  resolveTodoSuggestion,
  todoSuppressionReason,
  senderKeyFor,
  senderPriorWriteKeyFor,
  suggestTodo,
  triageWorkflowInputSchema,
  TRIAGE_WORKFLOW_SLUG,
  upsertTriage,
  type ClassifyAudit,
  type Observations,
  type SenderContextResult,
  type TriageClassification,
  type Workflow,
} from "@alfred/api";
import {
  senderContextSchema,
  toStringArray,
  type AccountPersona,
  type SenderContext,
  toMessage,
} from "@alfred/contracts";
import { TRIAGE_CATEGORIES, type TriageCategory } from "@alfred/integrations/google";
import { z } from "zod";

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
  /** Backfill-only: bypass the already-tagged skip guard (see input schema). */
  force: z.boolean().optional(),
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
      force: parsed.force,
    };
  },

  steps: {
    classify: {
      id: "classify",
      async run(ctx) {
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
        if (
          existing &&
          existing.runId !== ctx.runId &&
          existing.appliedLabelId &&
          !ctx.state.force
        ) {
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
          await ctx.log(`classify: reuse existing thread row category=${classification.category}`);
        } else {
          // Gather deterministic observations (ADR-0051 §4a) before the model
          // call. All reads are best-effort context; built before the try so
          // they're available for the sender_extraction log on the fallback
          // path too. Sender priors are read for bulk/service senders only
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
            // tells us why classification fell through — ctx.log only goes
            // to a transient event stream. `model="fallback"` is non-learnable
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

          // Recency-guarded, advisory-locked upsert. `written` is false when a
          // concurrent run for a strictly-newer message already owns the row —
          // this run lost the race, so it skips the side effects below (they'd
          // emit signals for a tag that isn't canonical). The apply-label step
          // converges on the row's canonical message regardless.
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
            authoredAt: ctxData.document.authoredAt,
          });
          written = upserted.written;
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

        // Sender-prior histogram write-back (ADR-0051 #2, Phase 2). Learns
        // ONLY from Alfred's own classifications and only for bulk senders:
        // skip human senders (`senderKeyFor` returns null) and the user's own
        // sent mail (defensive — sent docs are excluded from the triage
        // fan-out upstream, so this branch shouldn't see them). Skip fallback
        // labels too: an outage/default category is not a learning signal.
        // Best-effort: a prior write must never fail the label, which is the
        // contract. NEW-PATH ONLY: `incrementSenderPrior` is a non-idempotent
        // histogram bump, so a reuse re-attempt must not double-count — only
        // the originating classification teaches it.
        if (!reusedExistingRow && written) {
          const docIsSent = isSentGmailMetadata(ctxData.document.metadata);
          const senderKey = senderPriorWriteKeyFor({
            senderContext,
            senderAddress: senderContextResult.senderAddress,
            isSent: docIsSent,
            model,
          });
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
        // Pass the email's send time so relative deadlines ("due tomorrow")
        // resolve to an absolute date instead of going stale on the rail.
        const todoSuggestion = resolveTodoSuggestion(classification, ctxData.document.authoredAt);
        let standingSuppression: Awaited<ReturnType<typeof findActiveSenderSuppression>> = null;
        let standingSuppressionReadFailed = false;
        if (todoSuggestion) {
          try {
            standingSuppression = await findActiveSenderSuppression(ctx.userId, {
              senderEmail:
                senderContextResult.senderAddress ??
                metadataString(ctxData.document.metadata, "from"),
              accountId: ctxData.document.accountId,
              effect: "block_todo_suggestion",
            });
          } catch (err) {
            standingSuppressionReadFailed = true;
            await ctx.log(
              `standing_instruction: read failed for block_todo_suggestion (suppressing todo): ${toMessage(
                err,
              )}`,
            );
          }
        }
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
              sources: [{ provider: "gmail", kind: "thread", id: sourceThreadId }],
            });
            await ctx.log(
              `suggest_todo: ${suggested.status} todo=${suggested.todoId} category=${classification.category}`,
            );
          } catch (err) {
            await ctx.log(`suggest_todo failed (non-fatal): ${toMessage(err)}`);
          }
        }

        // Emit only on the new-classification path (the reuse branch has no
        // observations/audit to report). Logs the observation summary + the
        // classify audit (first pass, conflict, second pass, floor) so a bad
        // tag is debuggable without reading the raw email body.
        if (!reusedExistingRow && observations) {
          await ctx.log(
            `triage.sender_extraction ${JSON.stringify(
              senderExtractionEvent({
                senderContextResult,
                observations,
                audit,
                classification,
                todoSuggested: Boolean(todoSuggestion),
                standingSuppression,
                standingSuppressionReadFailed,
              }),
            )}`,
          );
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
      },
    },
  },
};

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
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
  const senderKey = senderKeyFor(args.senderContext, args.senderAddress);

  const isHumanSender = args.senderContext.effectiveAuthor === "person";
  const [senderPrior, thread, knownContact, senderRelationship] = await Promise.all([
    senderKey ? getSenderPrior(args.userId, senderKey).catch(() => null) : Promise.resolve(null),
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
    isHumanSender && args.senderAddress
      ? isKnownContact(args.userId, args.senderAddress).catch(() => false)
      : Promise.resolve(false),
    resolveSenderRelationship({
      userId: args.userId,
      senderAddress: args.senderAddress,
      isHumanSender,
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
    labelIds,
    signalText,
  });
}

/**
 * Structured `triage.sender_extraction` log payload. Explicitly typed (not
 * `Record<string, unknown>`) so a field rename or shape drift — this object is
 * JSON-stringified and parsed by downstream tooling — fails the build instead
 * of compiling silently. Field types are derived from the source types so they
 * stay in lockstep.
 */
interface SenderExtractionEvent {
  fromKind: SenderContext["fromKind"];
  bodyActor: SenderContext["bodyActor"] | null;
  effectiveAuthor: SenderContext["effectiveAuthor"];
  botSlug: string | null;
  parserHit: SenderContextResult["parserHit"];
  senderAddress: SenderContextResult["senderAddress"];
  senderDomain: SenderContextResult["senderDomain"];
  persona: AccountPersona | null;
  senderPriorKey: string | null;
  senderPriorCounts: Record<string, number>;
  knownContact: boolean;
  /** Rendered Sender relationship descriptor (ADR-0059), or null for non-human senders — logged for rubric tuning. */
  senderRelationship: string | null;
  threadMessages: number;
  threadNewest: Observations["thread"]["newestDirection"];
  gmailImportant: boolean;
  gmailCategories: string[];
  contentFlags: Observations["content"];
  firstPassCategory: TriageCategory | null;
  firstPassConfidence: number | null;
  conflict: NonNullable<ClassifyAudit["conflict"]>["kind"] | null;
  secondPassCategory: TriageCategory | null;
  secondPassFailure: string | null;
  floorMatched: boolean;
  floorForced: boolean;
  finalCategory: TriageCategory;
  finalConfidence: number;
  todoSuggested: boolean;
  standingInstructionSuppressedTodo: boolean;
  standingInstructionFactId: string | null;
  standingInstructionEffect: string | null;
  standingInstructionReadFailed: boolean;
  /** Which rubric test decided the todo call (rule 16); null on producers that don't emit it. */
  todoOutcome: string | null;
  todoNote: string | null;
}

/**
 * Flatten the observation summary + classify audit into a single structured log
 * line (`triage.sender_extraction`, ADR-0051 — Phase 5 will formalize the
 * event). Enough to debug a bad tag without the raw email body.
 */
function senderExtractionEvent(args: {
  senderContextResult: SenderContextResult;
  observations: Observations;
  audit: ClassifyAudit | null;
  classification: TriageClassification;
  todoSuggested: boolean;
  standingSuppression: Awaited<ReturnType<typeof findActiveSenderSuppression>>;
  standingSuppressionReadFailed: boolean;
}): SenderExtractionEvent {
  const { context } = args.senderContextResult;
  const obs = args.observations;
  const audit = args.audit;
  return {
    // sender
    fromKind: context.fromKind,
    bodyActor: context.bodyActor ?? null,
    effectiveAuthor: context.effectiveAuthor,
    botSlug: context.botSlug ?? null,
    parserHit: args.senderContextResult.parserHit,
    senderAddress: args.senderContextResult.senderAddress,
    senderDomain: args.senderContextResult.senderDomain,
    // observations
    persona: obs.persona,
    senderPriorKey: obs.senderPrior.key,
    senderPriorCounts: obs.senderPrior.categoryCounts,
    knownContact: obs.knownContact,
    senderRelationship: obs.senderRelationship,
    threadMessages: obs.thread.messageCount,
    threadNewest: obs.thread.newestDirection,
    gmailImportant: obs.gmail.important,
    gmailCategories: obs.gmail.categories,
    contentFlags: obs.content,
    // classify audit (null on the fallback/default path)
    firstPassCategory: audit?.firstPass.category ?? null,
    firstPassConfidence: audit?.firstPass.confidence ?? null,
    conflict: audit?.conflict?.kind ?? null,
    secondPassCategory: audit?.secondPass?.category ?? null,
    secondPassFailure: audit?.secondPassFailure?.message ?? null,
    floorMatched: audit?.floorMatched ?? false,
    floorForced: audit?.floorForced ?? false,
    // final outcome
    finalCategory: args.classification.category,
    finalConfidence: args.classification.confidence,
    todoSuggested: args.todoSuggested,
    standingInstructionSuppressedTodo: Boolean(args.standingSuppression),
    standingInstructionFactId: args.standingSuppression?.factId ?? null,
    standingInstructionEffect: args.standingSuppression?.effect ?? null,
    standingInstructionReadFailed: args.standingSuppressionReadFailed,
    todoOutcome: args.classification.todoDecision?.outcome ?? null,
    todoNote: args.classification.todoDecision?.note ?? null,
  };
}
