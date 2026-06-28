import {
  accumulateDoc,
  applyCorrespondenceIncrements,
  type ContactAggregate,
  extractFactsFromDocument,
  gateDocumentFact,
  listFactsByStatus,
  loadSelfIdentity,
  proposeFact,
  runSignificancePass,
  type FactProposal,
  factProposalSchema,
  type Workflow,
  writeMemoryChunk,
} from "@alfred/api";
import { isRecord, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, memoryExtractionStatus, user, userFacts } from "@alfred/db/schemas";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * Daily memory-extraction workflow (ADR-0019, ADR-0025 #3).
 *
 * Steps:
 *   1. pick-documents  — query docs authored within `sinceDays` that haven't
 *                        been extracted in the last `sinceDays` window.
 *   2. process         — for each doc, run the cheap-tier extractor (or use
 *                        injected proposals in manual/test mode), call
 *                        `proposeFact` for each output, upsert the per-doc
 *                        status row.
 *   3. finalize        — write a `memory_chunks` row summarizing what landed
 *                        and finish with the run tally.
 *
 * Why a single `process` step (not a step per doc): looping back to the
 * same step id collides with the executor's `(runId, stepId, attempt)`
 * unique key on `agent_steps`. Recovery comes from the per-doc upserts
 * — a retry skips docs already marked extracted, so progress is preserved
 * even when the step fails midway through a 20-doc batch.
 *
 * Triggers:
 *   - Daily cron (`memory.extract.daily`) — primary path.
 *   - Manual: smoke scripts pass `mode: 'manual'` + `manualProposals` to
 *     bypass the LLM call without losing the workflow's persistence path.
 *   - End-of-thread / event-triggered (ADR-0019) wire in once chats and
 *     the email-triage flow exist (m9+).
 */

// ---------------------------------------------------------------------------
// state schema
// ---------------------------------------------------------------------------

const stateSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  /** Doc-id keyed proposals — populated only in manual mode. */
  manualProposals: z.record(z.string(), z.array(factProposalSchema)).optional(),
  sinceDays: z.number().int().positive(),
  maxDocs: z.number().int().positive(),
  /** Populated by pick-documents step. */
  documentIds: z.array(z.string()),
  /** ISO timestamp captured at run-create — used for the cutoff queries. */
  startedAt: z.string(),
  /** Tally — populated by the process step. */
  processed: z.number().int().nonnegative(),
  proposed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
});
type State = z.infer<typeof stateSchema>;

// ---------------------------------------------------------------------------
// input handling
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  mode: z.enum(["auto", "manual"]).default("auto"),
  manualProposals: z.record(z.string(), z.array(factProposalSchema)).optional(),
  sinceDays: z.number().int().positive().default(7),
  maxDocs: z.number().int().positive().max(100).default(20),
});

// ---------------------------------------------------------------------------
// workflow
// ---------------------------------------------------------------------------

export const memoryExtractionWorkflow: Workflow<State> = {
  slug: "memory-extraction",
  name: "Memory extraction",
  description: "Daily extraction of structured facts from recently-ingested documents (ADR-0019).",
  // Declared as cron for honesty; `next_run_at` stays null at seed time
  // so the generic workflows.tick skips it. The per-feature
  // `memory.extract.daily` BullMQ repeatable (memory/repeatable.ts)
  // owns dispatch today. Future: migrate onto workflows.tick with a
  // per-user schedule and retire the per-feature tick.
  trigger: { kind: "cron", schedule: "0 3 * * *" },
  initialStep: "pick-documents",
  stateSchema,

  initialState(input) {
    const parsed = inputSchema.parse(input.input ?? {});
    return {
      mode: parsed.mode,
      manualProposals: parsed.manualProposals,
      sinceDays: parsed.sinceDays,
      maxDocs: parsed.maxDocs,
      documentIds: [],
      startedAt: new Date().toISOString(),
      processed: 0,
      proposed: 0,
      blocked: 0,
    };
  },

  steps: {
    "pick-documents": {
      id: "pick-documents",
      async run(ctx) {
        const cutoff = new Date(Date.now() - ctx.state.sinceDays * 24 * 60 * 60 * 1000);

        // In manual mode, the smoke script tells us exactly which docs to
        // process — bypass the freshness query so the test isn't subject
        // to "did the doc land within the sliding window" timing.
        let ids: string[];
        if (ctx.state.mode === "manual" && ctx.state.manualProposals) {
          ids = Object.keys(ctx.state.manualProposals).slice(0, ctx.state.maxDocs);
        } else {
          // Anti-join against memory_extraction_status: pick docs whose
          // last extraction (if any) was before the cutoff.
          const rows = await db()
            .select({ id: documents.id })
            .from(documents)
            .leftJoin(memoryExtractionStatus, eq(memoryExtractionStatus.documentId, documents.id))
            .where(
              and(
                eq(documents.userId, ctx.userId),
                gte(documents.authoredAt, cutoff),
                sql`(${memoryExtractionStatus.documentId} IS NULL OR ${memoryExtractionStatus.lastExtractedAt} < ${cutoff})`,
              ),
            )
            .orderBy(desc(documents.authoredAt))
            .limit(ctx.state.maxDocs);
          ids = rows.map((r) => r.id);
        }

        await ctx.log(`pick-documents: selected ${ids.length} doc(s) for extraction`);
        return {
          kind: "next",
          state: { ...ctx.state, documentIds: ids },
          nextStep: "process",
        };
      },
    },

    process: {
      id: "process",
      async run(ctx) {
        let processed = 0;
        let proposed = 0;
        let blocked = 0;

        // Pull the user's confirmed facts once — pass to extractor as
        // hints so it doesn't re-propose what we already know. Cheap.
        const existing =
          ctx.state.mode === "auto" ? await listFactsByStatus(ctx.userId, "confirmed", 50) : [];
        const existingForPrompt = existing.map((f) => ({ key: f.key, value: f.value }));

        // Team-graph capture (ADR-0059 P4a) rides this same per-doc loop:
        // not-yet-captured Gmail docs increment the sender graph header-only (no
        // LLM). Skipped in manual mode (smoke tests bypass the real doc window).
        // Capture is gated by its OWN marker (`captured_into_graph_at`), not by
        // extraction state, so the two stay independent.
        const captureEnabled = ctx.state.mode === "auto";
        const [selfRow] = captureEnabled
          ? await db()
              .select({ email: user.email })
              .from(user)
              .where(eq(user.id, ctx.userId))
              .limit(1)
          : [];
        const selfEmail = (selfRow?.email ?? "").trim().toLowerCase();

        // Self-identity for the Tier-B authorship gate (#330, ADR-0079). Prefer
        // the per-account Gmail/GitHub identities (`documents.accountId` →
        // connected-account email/login) over the bare global `user.email`, so a
        // work mailbox isn't matched against a personal address. Built once per
        // run; only consulted in auto mode (manual proposals bypass the gate).
        const selfIdentity = captureEnabled
          ? await loadSelfIdentity(ctx.userId)
          : { emails: selfEmail ? [selfEmail] : [] };
        const captureContacts = new Map<string, ContactAggregate>();
        // Docs whose headers we fold this run; stamped captured only after the
        // increments commit (see the post-loop transaction).
        const capturedThisRun: string[] = [];
        // Docs in this batch already folded on a prior run — skip them.
        const alreadyCaptured =
          captureEnabled && ctx.state.documentIds.length > 0
            ? new Set(
                (
                  await db()
                    .select({ documentId: memoryExtractionStatus.documentId })
                    .from(memoryExtractionStatus)
                    .where(
                      and(
                        eq(memoryExtractionStatus.userId, ctx.userId),
                        inArray(memoryExtractionStatus.documentId, ctx.state.documentIds),
                        isNotNull(memoryExtractionStatus.capturedIntoGraphAt),
                      ),
                    )
                ).map((r) => r.documentId),
              )
            : new Set<string>();

        for (const docId of ctx.state.documentIds) {
          const doc = await loadDocument(docId, ctx.userId);
          if (!doc) {
            // Doc disappeared between picking and processing — skip.
            continue;
          }

          let proposals: FactProposal[];
          if (ctx.state.mode === "manual") {
            proposals = ctx.state.manualProposals?.[docId] ?? [];
          } else {
            try {
              proposals = await extractFactsFromDocument({
                userId: ctx.userId,
                document: doc,
                existingFacts: existingForPrompt,
                runId: ctx.runId,
                stepId: "process",
                idempotencyKey: `${ctx.idempotencyKey}:${docId}`,
              });
            } catch (err) {
              await ctx.log(`extract failed for doc=${docId}: ${toMessage(err)}`);
              proposals = [];
            }
          }

          let docProposed = 0;
          let docBlocked = 0;
          for (const p of proposals) {
            let key = p.key;
            let value: unknown = p.value;
            let sourceMeta: Record<string, unknown> = { rationale: p.rationale };
            // Per-document write gate (#330): the contextual authorship check
            // `proposeFact` can't do. Manual mode bypasses it (test fixtures);
            // `proposeFact` still backstops canonicalization + the document
            // allow-list either way.
            if (ctx.state.mode === "auto") {
              const gate = gateDocumentFact({
                proposal: { key: p.key, value: p.value },
                document: { source: doc.source, metadata: doc.metadata, accountId: doc.accountId },
                selfIdentity,
              });
              if (!gate.ok) {
                docBlocked++;
                const authorshipReason =
                  gate.authorship && !gate.authorship.authoredByUser
                    ? ` authorship=${gate.authorship.reason}`
                    : "";
                await ctx.log(
                  `memory-gate blocked doc=${doc.id} key=${JSON.stringify(p.key)} ` +
                    `reason=${gate.reason}${authorshipReason}`,
                );
                continue;
              }
              key = gate.key;
              value = gate.value;
              sourceMeta = {
                ...sourceMeta,
                ...gate.meta,
                ...(gate.authorship?.authoredByUser
                  ? {
                      documentAuthoredByUser: true,
                      authorship: {
                        source: gate.authorship.source,
                        method: gate.authorship.proof.method,
                      },
                    }
                  : {}),
              };
            }
            const result = await proposeFact({
              userId: ctx.userId,
              key,
              value,
              confidence: p.confidence,
              source: { kind: "document", id: doc.id, meta: sourceMeta },
            });
            if (result) docProposed++;
            else docBlocked++;
          }

          // Mark the doc processed even if no proposals landed — same row
          // updated on subsequent runs so we don't re-LLM until the
          // extracted_at falls outside the sinceDays window. (Graph capture
          // tracks itself separately via `captured_into_graph_at`, stamped
          // after the post-loop increments commit — never here.)
          await db()
            .insert(memoryExtractionStatus)
            .values({
              documentId: doc.id,
              userId: ctx.userId,
              lastRunId: ctx.runId,
              proposedCount: docProposed,
            })
            .onConflictDoUpdate({
              target: memoryExtractionStatus.documentId,
              set: {
                lastExtractedAt: new Date(),
                lastRunId: ctx.runId,
                proposedCount: docProposed,
              },
            });

          if (
            captureEnabled &&
            !alreadyCaptured.has(doc.id) &&
            doc.source === "gmail" &&
            isRecord(doc.metadata)
          ) {
            accumulateDoc(captureContacts, doc.metadata, doc.authoredAt ?? null, selfEmail);
            capturedThisRun.push(doc.id);
          }

          processed++;
          proposed += docProposed;
          blocked += docBlocked;
        }

        // Fold the run's newly-seen correspondence into the team graph
        // (increment, not overwrite) and stamp those docs captured — both in
        // ONE transaction, so a failed apply rolls the stamp back too and the
        // next run retries (at-least-once, never double-counted). Zero-yield
        // docs (all-service senders) still get stamped so we don't rescan them.
        // The significance re-pass runs in finalize. Best-effort: a failure
        // here never fails the run.
        if (captureEnabled && capturedThisRun.length > 0) {
          try {
            const applied = await db().transaction(async (tx) => {
              const res = await applyCorrespondenceIncrements(ctx.userId, captureContacts, tx);
              await tx
                .update(memoryExtractionStatus)
                .set({ capturedIntoGraphAt: new Date() })
                .where(
                  and(
                    eq(memoryExtractionStatus.userId, ctx.userId),
                    inArray(memoryExtractionStatus.documentId, capturedThisRun),
                  ),
                );
              return res;
            });
            await ctx.log(
              `team-graph capture: ${capturedThisRun.length} new doc(s) → ` +
                `${applied.contacts} contact(s), ${applied.organizations} org(s), ${applied.relations} edge(s)`,
            );
          } catch (err) {
            await ctx.log(
              `team-graph capture failed (un-stamped docs retry next run): ${toMessage(err)}`,
            );
          }
        }

        await ctx.log(`process: docs=${processed} proposed=${proposed} blocked=${blocked}`);
        return {
          kind: "next",
          state: { ...ctx.state, processed, proposed, blocked },
          nextStep: "finalize",
        };
      },
    },

    finalize: {
      id: "finalize",
      async run(ctx) {
        // Full significance re-pass over every person entity (ADR-0059 P4a).
        // Recency decay drifts even untouched scores day-to-day, so a full pass
        // (not just the contacts touched this run) keeps the scalar fresh. Cheap
        // and in-memory; skipped in manual mode. Best-effort — never fails the run.
        let significanceScored = 0;
        if (ctx.state.mode === "auto") {
          try {
            const pass = await runSignificancePass(ctx.userId, { commit: true });
            significanceScored = pass.scored;
            await ctx.log(
              `significance pass: scored ${pass.scored}/${pass.total} person entit(ies)`,
            );
          } catch (err) {
            await ctx.log(`significance pass failed: ${toMessage(err)}`);
          }
        }

        // Write a memory_chunk so the run leaves a recallable trace —
        // future "what did alfred learn this week" queries hit this.
        // Idempotent on (user, kind, content_hash) so a retry is safe.
        const summary =
          `Memory-extraction run ${ctx.runId} (${ctx.state.startedAt}): ` +
          `processed ${ctx.state.processed} document(s); ` +
          `proposed ${ctx.state.proposed} fact(s); ` +
          `${ctx.state.blocked} suppressed by dedup/rejection guards; ` +
          `significance scored ${significanceScored} contact(s).`;

        await writeMemoryChunk({
          userId: ctx.userId,
          kind: "extraction_run",
          content: summary,
          source: { kind: "agent", id: ctx.runId, meta: { workflow: "memory-extraction" } },
          metadata: {
            mode: ctx.state.mode,
            sinceDays: ctx.state.sinceDays,
            maxDocs: ctx.state.maxDocs,
            documentIds: ctx.state.documentIds,
          },
        });

        return {
          kind: "done",
          state: ctx.state,
          output: {
            processed: ctx.state.processed,
            proposed: ctx.state.proposed,
            blocked: ctx.state.blocked,
            documentIds: ctx.state.documentIds,
          },
        };
      },
    },
  },
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function loadDocument(docId: string, userId: string) {
  const [row] = await db()
    .select({
      id: documents.id,
      title: documents.title,
      content: documents.content,
      source: documents.source,
      authoredAt: documents.authoredAt,
      metadata: documents.metadata,
      accountId: documents.accountId,
    })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.userId, userId)))
    .limit(1);
  return row;
}

// Defensive — re-export so the workflow module also exposes its own type
// signatures (useful for the smoke-extract script).
export type MemoryExtractionInput = z.infer<typeof inputSchema>;

// Silence unused-import warning if userFacts ever drops from this file.
// (kept intentionally — schema reference for future per-key audit logic.)
void userFacts;
