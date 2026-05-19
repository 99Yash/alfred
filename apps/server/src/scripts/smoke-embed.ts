/**
 * m7b smoke test — exercises chunker → Voyage → pgvector search.
 *
 *   $ pnpm tsx --env-file=.env src/scripts/smoke-embed.ts
 *
 * Voyage's free tier rate-limits at 3 RPM, so this smoke deliberately
 * makes only **two** Voyage calls (one document embed + one query
 * embed). That's enough to prove every link in the chain:
 *
 *   chunkText → embedDocument → chunks rows with 1024-dim vectors →
 *   metered() row in api_call_log with non-zero cost → semanticSearch
 *   joins back to documents and returns top-K.
 */
import { closeConnections, warmPool } from "@alfred/api";
import { db } from "@alfred/db";
import { apiCallLog, chunks, documents, user as userTable } from "@alfred/db/schemas";
import { embedDocument, semanticSearch } from "@alfred/ingestion";
import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";

const SMOKE_DOC = {
  source: "smoke",
  sourceId: "m7b-quarterly-update",
  title: "Quarterly board update — financials",
  body: `Q1 revenue came in at $4.2M, up 18% YoY. Gross margin held at 72%.
The board reviewed the new budget for Q2 and approved a $1.5M increase
in marketing spend. Cash runway is now 19 months at current burn.

We plan to raise a Series B in the next 6-9 months pending strong Q2
results. The CFO will share updated pipeline data next week.`,
};

async function findOrCreateUser(): Promise<string> {
  const email = "smoke-embed@alfred.local";
  const existing = await db().select().from(userTable).where(eq(userTable.email, email));
  if (existing[0]) return existing[0].id;
  const inserted = await db()
    .insert(userTable)
    .values({ name: "Embed Tester", email, emailVerified: true })
    .returning({ id: userTable.id });
  return inserted[0]!.id;
}

async function upsertDoc(userId: string): Promise<string> {
  const content = `Subject: ${SMOKE_DOC.title}\n\n${SMOKE_DOC.body}`;
  const result = await db()
    .insert(documents)
    .values({
      userId,
      source: SMOKE_DOC.source,
      sourceId: SMOKE_DOC.sourceId,
      title: SMOKE_DOC.title,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      authoredAt: new Date(),
      metadata: {},
    })
    .onConflictDoNothing({ target: [documents.userId, documents.source, documents.sourceId] })
    .returning({ id: documents.id });
  if (result[0]) return result[0].id;
  const existing = await db()
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, SMOKE_DOC.source),
        eq(documents.sourceId, SMOKE_DOC.sourceId),
      ),
    );
  return existing[0]!.id;
}

async function main() {
  await warmPool();

  const userId = await findOrCreateUser();
  console.log(`[smoke-embed] userId=${userId}`);

  const docId = await upsertDoc(userId);
  console.log(`[smoke-embed] docId=${docId}`);

  // Wipe chunks to force a real Voyage call regardless of prior state.
  await db().delete(chunks).where(eq(chunks.documentId, docId));

  // ---- One embed call: index the doc -------------------------------------
  const embedResult = await embedDocument({
    documentId: docId,
    idempotencyKey: "m7b-smoke",
  });
  console.log(
    `[smoke-embed] embedded: written=${embedResult.chunksWritten} skipped=${embedResult.chunksSkipped}`,
  );
  if (embedResult.chunksWritten === 0) {
    throw new Error("expected ≥1 chunk written");
  }

  // Verify chunk shape.
  const sample = await db()
    .select({ embedding: chunks.embedding, content: chunks.content })
    .from(chunks)
    .where(eq(chunks.documentId, docId))
    .limit(1);
  const embedding = sample[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== 1024) {
    throw new Error(
      `chunk embedding shape wrong: type=${typeof embedding} len=${Array.isArray(embedding) ? embedding.length : "n/a"}`,
    );
  }
  console.log(`[smoke-embed] chunk embedding: 1024-dim ✓ (sample[0]=${embedding[0]?.toFixed(4)})`);

  // Re-embed must be a no-op (content_hash unchanged → no Voyage call).
  const reembed = await embedDocument({ documentId: docId });
  if (reembed.chunksWritten !== 0) {
    throw new Error(`re-embed wrote ${reembed.chunksWritten} chunks (expected 0)`);
  }
  console.log("[smoke-embed] re-embed is a no-op ✓");

  // ---- One embed call: query --------------------------------------------
  const hits = await semanticSearch({
    query: "what's our quarterly revenue and cash runway?",
    userId,
    source: "smoke",
    limit: 3,
  });
  if (hits.length === 0) throw new Error("search returned 0 hits");
  const top = hits[0]!;
  console.log(`[smoke-embed] top hit: "${top.title}" sim=${top.similarity.toFixed(3)}`);
  if (!top.title?.includes("Quarterly")) {
    throw new Error(`top hit title mismatch: ${top.title}`);
  }
  if (top.similarity < 0.3) {
    throw new Error(`top similarity suspiciously low: ${top.similarity}`);
  }

  // ---- Verify metering captured the embed call --------------------------
  const recent = await db()
    .select()
    .from(apiCallLog)
    .where(eq(apiCallLog.kind, "embedding"))
    .orderBy(desc(apiCallLog.id))
    .limit(1);
  if (!recent[0]) throw new Error("no embedding row in api_call_log");
  const cost = Number(recent[0].costUsd);
  console.log(
    `[smoke-embed] last embed: ${recent[0].provider}/${recent[0].model} ` +
      `tokens=${recent[0].inputTokens} cost_usd=${cost.toFixed(8)}`,
  );
  if (cost <= 0) {
    throw new Error(`embed cost not computed (got ${recent[0].costUsd}); voyage prices missing?`);
  }

  console.log("\n[smoke-embed] PASS");
}

main()
  .catch((err) => {
    console.error("[smoke-embed] FAIL", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeConnections().catch(() => {});
  });
