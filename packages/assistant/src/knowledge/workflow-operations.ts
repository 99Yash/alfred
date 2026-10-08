import { writeMemoryChunk } from "./chunks";
import { extractFactsFromDocument, type FactProposal } from "./extraction";
import { gateDocumentFact } from "./fact-policy";
import { listFactsByStatus, proposeFact } from "./facts";
import {
  describeMemoryExtractionOutcome,
  summarizeMemoryExtractionRun,
} from "./memory-extraction-outcome";
import { loadSelfIdentity } from "./self-identity";
import { runSignificancePass } from "./significance";
import { gmailPayloadSignalsFromHeaders } from "./gmail-reducer";
import {
  accumulateDoc,
  applyCorrespondenceIncrements,
  gmailRawHeadersColumn,
  type ContactAggregate,
} from "./team-graph";
import type { StepContext, StepResult } from "@alfred/assistant/execution";
import { isRecord, toMessage, type GmailSenderParser, type JsonObject } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, memoryExtractionStatus, user, userFacts } from "@alfred/db/schemas";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";

/**
 * Daily memory-extraction workflow (ADR-0019, ADR-0025 #3): pick documents,
 * process them, finalize with a `memory_chunks` summary.
 *
 * One `process` step, not one per doc: reusing a step id collides with the
 * `(runId, stepId, attempt)` key on `agent_steps`. Per-doc status upserts let a
 * retry skip finished docs. Smoke scripts pass `mode: 'manual'` to skip the LLM.
 */

export interface MemoryExtractionOperationState {
  mode: "auto" | "manual";
  manualProposals?: Record<string, FactProposal[]> | undefined;
  sinceDays: number;
  maxDocs: number;
  documentIds: string[];
  startedAt: string;
  processed: number;
  /** Loaded documents whose extractor call threw. An all-throw run is an extractor bug (#1109). */
  extractionErrors: number;
  proposed: number;
  blocked: number;
}

export async function runMemoryPickDocuments<State extends MemoryExtractionOperationState>(
  ctx: StepContext<State>,
): Promise<StepResult<State>> {
  const cutoff = new Date(Date.now() - ctx.state.sinceDays * 24 * 60 * 60 * 1000);

  // Manual mode names its docs, so it skips the time window.
  let ids: string[];

  if (ctx.state.mode === "manual" && ctx.state.manualProposals) {
    ids = Object.keys(ctx.state.manualProposals).slice(0, ctx.state.maxDocs);
  } else {
    // Anti-join: docs whose last extraction, if any, is older than the cutoff.
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
}

export async function runMemoryProcess<State extends MemoryExtractionOperationState>(
  sender: GmailSenderParser,
  ctx: StepContext<State>,
): Promise<StepResult<State>> {
  let processed = 0;
  let extractionErrors = 0;
  let proposed = 0;
  let blocked = 0;

  // Confirmed facts, passed as hints so the extractor does not re-propose them.
  const existing =
    ctx.state.mode === "auto" ? await listFactsByStatus(ctx.userId, "confirmed", 50) : [];

  const existingForPrompt = existing.map((f) => ({ key: f.key, value: f.value }));

  // Team-graph capture (ADR-0059 P4a) rides this loop, header-only. It has its own
  // `captured_into_graph_at` marker, independent of extraction. Auto mode only.
  const captureEnabled = ctx.state.mode === "auto";

  const [selfRow] = captureEnabled
    ? await db().select({ email: user.email }).from(user).where(eq(user.id, ctx.userId)).limit(1)
    : [];

  const selfEmail = (selfRow?.email ?? "").trim().toLowerCase();

  // Self identity for the Tier B authorship gate (#330). Per-account identities
  // win over `user.email`, so a work mailbox is not matched to a personal address.
  const selfIdentity = captureEnabled
    ? await loadSelfIdentity(ctx.userId)
    : { emails: selfEmail ? [selfEmail] : [] };

  const captureContacts = new Map<string, ContactAggregate>();
  // Stamped captured only after the post-loop increments commit.
  const capturedThisRun: string[] = [];

  // Already folded on a prior run.
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
      // Deleted between pick and process.
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
        // Count it: a swallowed throw made a broken extractor look empty (#1109).
        extractionErrors++;
        proposals = [];
      }
    }

    let docProposed = 0;
    let docBlocked = 0;

    for (const p of proposals) {
      let key = p.key;
      let value: unknown = p.value;
      let sourceMeta: JsonObject = { rationale: p.rationale };

      // The authorship check `proposeFact` cannot do (#330). Manual mode skips it.
      if (ctx.state.mode === "auto") {
        const gate = gateDocumentFact({
          proposal: { key: p.key, value: p.value },
          document: {
            source: doc.source,
            metadata: doc.metadata,
            accountId: doc.accountId,
            // Parsed by the injected triage adapter (ADR-0089).
            sender: doc.source === "gmail" ? sender.authorship(doc.metadata) : null,
          },
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

    // Mark processed even with no proposals, so the doc waits for the window to pass.
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
      accumulateDoc(
        captureContacts,
        sender.correspondents(doc.metadata),
        doc.authoredAt ?? null,
        selfEmail,
        gmailPayloadSignalsFromHeaders(doc.gmailHeaders),
      );
      capturedThisRun.push(doc.id);
    }

    processed++;
    proposed += docProposed;
    blocked += docBlocked;
  }

  // Increment the graph and stamp the docs in one transaction, so a failure rolls
  // the stamp back and the next run retries. Docs with no yield are stamped too.
  // Best effort: never fails the run.
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
          `${applied.contacts} contact(s), ${applied.organizations} org(s), ` +
          `${applied.nonPersonContacts} non-person (re-kind blocked ${applied.reKindBlocked})`,
      );
    } catch (err) {
      await ctx.log(
        `team-graph capture failed (un-stamped docs retry next run): ${toMessage(err)}`,
      );
    }
  }

  await ctx.log(
    `process: docs=${processed} errors=${extractionErrors} ` +
      `proposed=${proposed} blocked=${blocked}`,
  );

  return {
    kind: "next",
    state: { ...ctx.state, processed, extractionErrors, proposed, blocked },
    nextStep: "finalize",
  };
}

export async function runMemoryFinalize<State extends MemoryExtractionOperationState>(
  ctx: StepContext<State>,
): Promise<StepResult<State>> {
  // Full significance pass: recency decay moves untouched scores daily. Best effort.
  let significanceScored = 0;

  if (ctx.state.mode === "auto") {
    try {
      const pass = await runSignificancePass(ctx.userId, { commit: true });
      significanceScored = pass.scored;
      await ctx.log(`significance pass: scored ${pass.scored}/${pass.total} person entit(ies)`);
    } catch (err) {
      await ctx.log(`significance pass failed: ${toMessage(err)}`);
    }
  }

  // A recallable `memory_chunk` trace, idempotent on content hash. The outcome
  // names which zero this run reports (#1109).
  const outcome = summarizeMemoryExtractionRun({
    picked: ctx.state.documentIds.length,
    processed: ctx.state.processed,
    // Needed: a run resumed from before this field shipped has it absent, and the
    // executor skips the schema `.default(0)` on this path.
    errors: ctx.state.extractionErrors ?? 0,
    proposed: ctx.state.proposed,
    blocked: ctx.state.blocked,
  });

  const summary =
    `Memory-extraction run ${ctx.runId} (${ctx.state.startedAt}): ` +
    `${describeMemoryExtractionOutcome(outcome)}; ` +
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
      outcome,
    },
  });

  return {
    kind: "done",
    state: ctx.state,
    output: { outcome, documentIds: ctx.state.documentIds },
  };
}

// --- helpers ---

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
      gmailHeaders: gmailRawHeadersColumn,
    })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.userId, userId)))
    .limit(1);

  return row;
}

// Keeps the `userFacts` import alive.
void userFacts;
