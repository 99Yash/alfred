/**
 * Smoke test for the memory fact lifecycle: propose, confirm, supersede, edit,
 * reject, preferences, memory chunks, and (with `VOYAGE_API_KEY`) embed and recall.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-memory.ts
 */
import type { ClaimProvenance } from "@alfred/contracts";
import {
  claimProducer,
  confirmFact,
  editFact,
  getSupersessionChain,
  listFactsByStatus,
  proposeFact,
  recallActiveByKey,
  recallLatestByKey,
  recallMemory,
  rejectFact,
  writeMemoryChunk,
} from "@alfred/assistant/knowledge";
import { settings } from "@alfred/assistant/settings";
import {
  embedMemoryChunk,
  findPendingEmbedChunks,
  isRejected,
} from "@alfred/assistant/knowledge/internal";
import { agentQueue } from "@alfred/assistant/execution";
import { warmPool } from "@alfred/db";
import { embed } from "@alfred/ai/embeddings";
import { db } from "@alfred/db";
import { requireRow } from "@alfred/db/helpers";
import { user as userTable } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { closeScriptResources } from "../script-runtime";

async function findOrCreateSmokeUser(): Promise<string> {
  const email = "smoke-memory@alfred.local";
  const existing = await db().select().from(userTable).where(eq(userTable.email, email));

  if (existing[0]) return existing[0].id;

  const inserted = await db()
    .insert(userTable)
    .values({ name: "Smoke Memory", email, emailVerified: true })
    .returning({ id: userTable.id });

  return requireRow(inserted[0], "ensureUser").id;
}

/** An agent claim from an observation. The `smoke:*` keys are unknown, so mail evidence would drop them. */
function agentClaim(observationId: string): ClaimProvenance {
  return {
    author: "agent",
    evidence: [{ kind: "observation", id: observationId }],
    producer: claimProducer({ pipeline: "smoke" }),
  };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  await warmPool();
  const userId = await findOrCreateSmokeUser();
  console.log(`[smoke] userId=${userId}`);

  // A per-run key, so a rerun is not blocked by an earlier rejected_inferences row.
  const runTag = Math.random().toString(36).slice(2, 8);
  const managerKey = `smoke:manager:${runTag}`;
  const companyKey = `smoke:company:${runTag}`;
  const rejectedKey = `smoke:rejected:${runTag}`;

  // 1. an agent claim is proposed
  const proposed = await proposeFact({
    userId,
    key: managerKey,
    value: { name: "Alice Doe", email: "alice@example.com" },
    confidence: 0.6,
    ...agentClaim("obs_test_001"),
  });

  assert(proposed, "proposeFact returned null on a fresh key");
  assert(proposed.status === "proposed", `expected proposed, got ${proposed.status}`);
  console.log(`[smoke] 1. proposed agent claim ${proposed.id} status=${proposed.status}`);

  // 2. a high model confidence confirms nothing (ADR-0123)
  const highConfidence = await proposeFact({
    userId,
    key: companyKey,
    value: "Acme Corp",
    confidence: 0.99,
    ...agentClaim("obs_test_002"),
  });

  assert(highConfidence, "proposeFact returned null");
  assert(highConfidence.status === "proposed", `expected proposed, got ${highConfidence.status}`);
  console.log(`[smoke] 2. high-confidence agent claim stays proposed ${highConfidence.id}`);

  // 3. confirmFact transitions proposed → confirmed
  const confirmed = await confirmFact({
    factId: proposed.id,
    userId,
    seenRowVersion: proposed.rowVersion,
    exec: "own",
  });

  assert(confirmed, "confirmFact returned null for a proposed row");
  assert(confirmed.status === "confirmed", `expected confirmed, got ${confirmed.status}`);
  assert(confirmed.rowVersion > proposed.rowVersion, "confirmFact should bump rowVersion");
  console.log(`[smoke] 3. confirmed ${proposed.id}`);

  // 4. editFact creates a second generation
  const edited = await editFact({
    factId: confirmed.id,
    userId,
    newValue: { name: "Alice Q. Doe", email: "alice.doe@example.com" },
    exec: "own",
  });

  assert(edited, "editFact returned null");
  assert(edited.status === "confirmed", `edited row should be confirmed`);
  assert(edited.confidence === 1, `user-edits land at full confidence`);
  console.log(`[smoke] 4. edited ${confirmed.id} → ${edited.id}`);

  const chain = await getSupersessionChain(userId, edited.id);
  assert(chain.length === 3, `supersession chain should be 3 deep, got ${chain.length}`);
  console.log(`[smoke]    chain: ${chain.map((c) => `${c.id}(${c.status})`).join(" → ")}`);

  // 5. recall returns the latest active row
  const latest = await recallLatestByKey(userId, managerKey);
  assert(latest, "recallLatestByKey returned null");
  assert(latest.id === edited.id, `expected latest=${edited.id}, got ${latest.id}`);
  const all = await recallActiveByKey(userId, managerKey);
  assert(all.length === 1, `only one row should be active for ${managerKey}, got ${all.length}`);
  console.log(`[smoke] 5. recall returned latest ${latest.id}`);

  // 6. reject a fresh proposal → rejected_inferences write
  const toReject = await proposeFact({
    userId,
    key: rejectedKey,
    value: "Wrong Company",
    confidence: 0.7,
    ...agentClaim("obs_test_004"),
  });

  assert(toReject, "proposeFact returned null on fresh key");

  const rejected = await rejectFact({
    factId: toReject.id,
    userId,
    reason: { code: "wrong-entity", note: "smoke-test rejection" },
    exec: "own",
  });

  assert(rejected, "rejectFact returned null");
  assert(rejected.status === "rejected", `expected rejected, got ${rejected.status}`);
  const isBlocked = await isRejected(userId, rejectedKey, "Wrong Company");
  assert(isBlocked, "rejected_inferences should block a re-propose");
  console.log(`[smoke] 6. rejected ${toReject.id} and recorded signature`);

  // 7. re-proposing the same (key, value) is blocked
  const reprop = await proposeFact({
    userId,
    key: rejectedKey,
    value: "Wrong Company",
    confidence: 0.95,
    ...agentClaim("obs_test_005"),
  });

  assert(reprop === null, `extraction guard should return null, got ${JSON.stringify(reprop)}`);
  console.log(`[smoke] 7. re-extraction guard blocked the duplicate proposal`);

  // 8. preferences round-trip
  const prefKey = `smoke:tone:${runTag}`;
  // One bind: the reads after the writes prove a write drops the bind's loaded view.
  const userSettings = settings({ userId });
  const set1 = await userSettings.set(prefKey, "concise");
  assert(set1.value === "concise", `settings.set value mismatch`);
  const set2 = await userSettings.set(prefKey, "warm but concise");
  assert(set2.rowVersion > set1.rowVersion, `rowVersion should bump on overwrite`);
  const fetched = await userSettings.get(prefKey);
  assert(fetched && fetched.value === "warm but concise", `settings.get mismatch`);
  const all_prefs = await userSettings.all();
  assert(
    all_prefs.find((p) => p.key === prefKey),
    `settings.all should include our key`,
  );
  console.log(
    `[smoke] 8. preferences round-trip ok (rowVersion ${set1.rowVersion} → ${set2.rowVersion})`,
  );

  // 9. memory_chunks write, without embeddings
  const chunk = await writeMemoryChunk({
    userId,
    kind: "manual",
    content: `Smoke run ${runTag}: alice manages the data team and prefers concise updates.`,
    source: { kind: "user" },
    metadata: { tag: runTag },
  });

  assert(chunk.contentHash.length === 64, `expected sha256 hash, got ${chunk.contentHash}`);
  assert(chunk.hasEmbedding === false, `chunk should be unembedded at write`);

  const chunk2 = await writeMemoryChunk({
    userId,
    kind: "manual",
    content: `Smoke run ${runTag}: alice manages the data team and prefers concise updates.`,
    source: { kind: "user" },
  });

  assert(chunk2.id === chunk.id, `same content should dedup to same row`);
  console.log(`[smoke] 9. memory_chunk write idempotent ok (id=${chunk.id})`);

  // 10. listFactsByStatus surfaces what the memory page would show
  const proposedList = await listFactsByStatus(userId, "proposed");
  const confirmedList = await listFactsByStatus(userId, "confirmed");
  console.log(
    `[smoke] 10. status counts: proposed=${proposedList.length} confirmed=${confirmedList.length}`,
  );

  // 11. embed sweep + recall, inline like the `memory.embed_sweep` job. Needs VOYAGE_API_KEY.
  if (!process.env.VOYAGE_API_KEY) {
    console.log("[smoke] 11. skipped — VOYAGE_API_KEY unset");
  } else {
    const pending = await findPendingEmbedChunks(50);
    const ours = pending.find((p) => p.id === chunk.id);
    assert(ours, `chunk ${chunk.id} should be in pending list before embed`);

    const vec = await embed(chunk.content, {
      inputType: "document",
      userId,
      idempotencyKey: `smoke-memory:${chunk.id}`,
    });

    assert(vec.length === 1024, `expected 1024-dim vector, got ${vec.length}`);
    await embedMemoryChunk(chunk.id, userId, vec);

    const stillPending = await findPendingEmbedChunks(50);
    assert(
      !stillPending.find((p) => p.id === chunk.id),
      `chunk ${chunk.id} should no longer be pending after embed`,
    );

    const hits = await recallMemory({
      userId,
      query: "who manages the data team?",
      limit: 5,
    });

    const ourHit = hits.find((h) => h.chunkId === chunk.id);
    assert(ourHit, `recallMemory should surface our chunk ${chunk.id}`);
    assert(
      ourHit.similarity > 0.3,
      `expected meaningful similarity, got ${ourHit.similarity.toFixed(3)}`,
    );
    console.log(
      `[smoke] 11. embed+recall ok (similarity=${ourHit.similarity.toFixed(3)}, hits=${hits.length})`,
    );
  }

  console.log("\n[smoke] PASS");
}

try {
  await main();
} catch (err) {
  console.error("[smoke] FAIL", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
} finally {
  await closeScriptResources(agentQueue.close);
}
