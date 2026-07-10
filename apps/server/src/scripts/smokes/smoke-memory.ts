/**
 * Smoke test for the m8a/m8b memory primitives.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-memory.ts
 *
 * Exercises the full lifecycle:
 *
 *   1. propose a low-confidence fact → status=proposed
 *   2. propose a high-confidence fact → status=confirmed (auto-confirm)
 *   3. confirm the proposed one → status=confirmed
 *   4. supersede the confirmed one → old=superseded, new=confirmed, chain links back
 *   5. edit the new row → old=edited, newer=confirmed, full chain has 3 entries
 *   6. recall by key returns the latest active row
 *   7. reject a fresh proposal → rejected_inferences row written
 *   8. propose the same (key, value) again → returns null (re-extraction guard)
 *   9. preferences upsert / get / list
 *  10. memory chunk write + idempotent dedup
 *  11. status counts (what the memory page would show)
 *  12. (m8b) embed sweep + recallMemory round-trip — gated on VOYAGE_API_KEY
 *
 * Step 12 is skipped when `VOYAGE_API_KEY` is unset so the smoke stays
 * runnable without billable provider calls.
 */
import {
  AUTO_CONFIRM_THRESHOLD,
  confirmFact,
  editFact,
  embedMemoryChunk,
  findPendingEmbedChunks,
  getPreference,
  getPreferences,
  getSupersessionChain,
  isRejected,
  listFactsByStatus,
  proposeFact,
  recallActiveByKey,
  recallLatestByKey,
  recallMemory,
  rejectFact,
  setPreference,
  supersedeFact,
  writeMemoryChunk,
} from "@alfred/api/backend";
import { closeAgentQueue, closeConnections, closeRedis, warmPool } from "@alfred/api/runtime";
import { embed } from "@alfred/ai/embeddings";
import { db } from "@alfred/db";
import { user as userTable } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";

async function findOrCreateSmokeUser(): Promise<string> {
  const email = "smoke-memory@alfred.local";
  const existing = await db().select().from(userTable).where(eq(userTable.email, email));
  if (existing[0]) return existing[0].id;
  const inserted = await db()
    .insert(userTable)
    .values({ name: "Smoke Memory", email, emailVerified: true })
    .returning({ id: userTable.id });
  return inserted[0]!.id;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  await warmPool();
  const userId = await findOrCreateSmokeUser();
  console.log(`[smoke] userId=${userId}`);

  // Use a test key that's specific to this run so reruns don't collide
  // with each other through rejected_inferences (the rejection branch
  // would block re-propose).
  const runTag = Math.random().toString(36).slice(2, 8);
  const managerKey = `smoke:manager:${runTag}`;
  const companyKey = `smoke:company:${runTag}`;
  const rejectedKey = `smoke:rejected:${runTag}`;

  // ---------------------------------------------------------------------
  // 1. low-confidence proposal stays proposed
  // ---------------------------------------------------------------------
  const proposed = await proposeFact({
    userId,
    key: managerKey,
    value: { name: "Alice Doe", email: "alice@example.com" },
    confidence: 0.6,
    source: { kind: "document", id: "doc_test_001" },
  });
  assert(proposed, "proposeFact returned null on a fresh key");
  assert(proposed.status === "proposed", `expected proposed, got ${proposed.status}`);
  console.log(`[smoke] 1. proposed low-confidence fact ${proposed.id} status=${proposed.status}`);

  // ---------------------------------------------------------------------
  // 2. high-confidence proposal auto-confirms
  // ---------------------------------------------------------------------
  const autoConfirmed = await proposeFact({
    userId,
    key: companyKey,
    value: "Acme Corp",
    confidence: AUTO_CONFIRM_THRESHOLD + 0.05,
    source: { kind: "document", id: "doc_test_002" },
  });
  assert(autoConfirmed, "proposeFact returned null");
  assert(
    autoConfirmed.status === "confirmed",
    `expected auto-confirm, got ${autoConfirmed.status}`,
  );
  console.log(`[smoke] 2. auto-confirmed high-confidence fact ${autoConfirmed.id}`);

  // ---------------------------------------------------------------------
  // 3. confirmFact transitions proposed → confirmed
  // ---------------------------------------------------------------------
  const confirmed = await confirmFact(proposed.id, userId);
  assert(confirmed, "confirmFact returned null for a proposed row");
  assert(confirmed.status === "confirmed", `expected confirmed, got ${confirmed.status}`);
  assert(confirmed.rowVersion > proposed.rowVersion, "confirmFact should bump rowVersion");
  console.log(`[smoke] 3. confirmed ${proposed.id}`);

  // ---------------------------------------------------------------------
  // 4. supersedeFact creates new row + closes old
  // ---------------------------------------------------------------------
  const superseded = await supersedeFact({
    factId: confirmed.id,
    userId,
    newValue: { name: "Alice Doe", email: "alice.doe@example.com" },
    confidence: 0.9,
    source: { kind: "document", id: "doc_test_003" },
  });
  assert(superseded, "supersedeFact returned null");
  assert(superseded.status === "confirmed", `new row should auto-confirm`);
  assert(superseded.supersedesId === confirmed.id, `supersedesId should link to old row`);
  console.log(`[smoke] 4. superseded ${confirmed.id} → ${superseded.id}`);

  // ---------------------------------------------------------------------
  // 5. editFact creates a third generation
  // ---------------------------------------------------------------------
  const edited = await editFact({
    factId: superseded.id,
    userId,
    newValue: { name: "Alice Q. Doe", email: "alice.doe@example.com" },
  });
  assert(edited, "editFact returned null");
  assert(edited.status === "confirmed", `edited row should be confirmed`);
  assert(edited.confidence === 1, `user-edits land at full confidence`);
  console.log(`[smoke] 5. edited ${superseded.id} → ${edited.id}`);

  const chain = await getSupersessionChain(userId, edited.id);
  assert(chain.length === 3, `supersession chain should be 3 deep, got ${chain.length}`);
  console.log(`[smoke]    chain: ${chain.map((c) => `${c.id}(${c.status})`).join(" → ")}`);

  // ---------------------------------------------------------------------
  // 6. recall returns the latest active row
  // ---------------------------------------------------------------------
  const latest = await recallLatestByKey(userId, managerKey);
  assert(latest, "recallLatestByKey returned null");
  assert(latest.id === edited.id, `expected latest=${edited.id}, got ${latest.id}`);
  const all = await recallActiveByKey(userId, managerKey);
  assert(all.length === 1, `only one row should be active for ${managerKey}, got ${all.length}`);
  console.log(`[smoke] 6. recall returned latest ${latest.id}`);

  // ---------------------------------------------------------------------
  // 7. reject a fresh proposal → rejected_inferences write
  // ---------------------------------------------------------------------
  const toReject = await proposeFact({
    userId,
    key: rejectedKey,
    value: "Wrong Company",
    confidence: 0.7,
    source: { kind: "document", id: "doc_test_004" },
  });
  assert(toReject, "proposeFact returned null on fresh key");
  const rejected = await rejectFact({
    factId: toReject.id,
    userId,
    reason: { code: "wrong-entity", note: "smoke-test rejection" },
  });
  assert(rejected, "rejectFact returned null");
  assert(rejected.status === "rejected", `expected rejected, got ${rejected.status}`);
  const isBlocked = await isRejected(userId, rejectedKey, "Wrong Company");
  assert(isBlocked, "rejected_inferences should block a re-propose");
  console.log(`[smoke] 7. rejected ${toReject.id} and recorded signature`);

  // ---------------------------------------------------------------------
  // 8. re-proposing the same (key, value) is blocked
  // ---------------------------------------------------------------------
  const reprop = await proposeFact({
    userId,
    key: rejectedKey,
    value: "Wrong Company",
    confidence: 0.95,
    source: { kind: "document", id: "doc_test_005" },
  });
  assert(reprop === null, `extraction guard should return null, got ${JSON.stringify(reprop)}`);
  console.log(`[smoke] 8. re-extraction guard blocked the duplicate proposal`);

  // ---------------------------------------------------------------------
  // 9. preferences round-trip
  // ---------------------------------------------------------------------
  const prefKey = `smoke:tone:${runTag}`;
  const set1 = await setPreference({ userId, key: prefKey, value: "concise" });
  assert(set1.value === "concise", `setPreference value mismatch`);
  const set2 = await setPreference({ userId, key: prefKey, value: "warm but concise" });
  assert(set2.rowVersion > set1.rowVersion, `rowVersion should bump on overwrite`);
  const fetched = await getPreference(userId, prefKey);
  assert(fetched && fetched.value === "warm but concise", `getPreference mismatch`);
  const all_prefs = await getPreferences(userId);
  assert(
    all_prefs.find((p) => p.key === prefKey),
    `getPreferences should include our key`,
  );
  console.log(
    `[smoke] 9. preferences round-trip ok (rowVersion ${set1.rowVersion} → ${set2.rowVersion})`,
  );

  // ---------------------------------------------------------------------
  // 10. memory_chunks write — embedding-free path (recall is m8b)
  // ---------------------------------------------------------------------
  const chunk = await writeMemoryChunk({
    userId,
    kind: "manual",
    content: `Smoke run ${runTag}: alice manages the data team and prefers concise updates.`,
    source: { kind: "user" },
    metadata: { tag: runTag },
  });
  assert(chunk.contentHash.length === 64, `expected sha256 hash, got ${chunk.contentHash}`);
  assert(chunk.hasEmbedding === false, `chunk should be unembedded at write`);

  // Idempotency: re-writing the same content returns same hash.
  const chunk2 = await writeMemoryChunk({
    userId,
    kind: "manual",
    content: `Smoke run ${runTag}: alice manages the data team and prefers concise updates.`,
    source: { kind: "user" },
  });
  assert(chunk2.id === chunk.id, `same content should dedup to same row`);
  console.log(`[smoke] 10. memory_chunk write idempotent ok (id=${chunk.id})`);

  // ---------------------------------------------------------------------
  // 11. listFactsByStatus surfaces what the memory page would show
  // ---------------------------------------------------------------------
  const proposedList = await listFactsByStatus(userId, "proposed");
  const confirmedList = await listFactsByStatus(userId, "confirmed");
  console.log(
    `[smoke] 11. status counts: proposed=${proposedList.length} confirmed=${confirmedList.length}`,
  );

  // ---------------------------------------------------------------------
  // 12. m8b: embed sweep + recall round-trip
  //
  // Inline equivalent of `memory.embed_sweep` (the BullMQ job): pull
  // pending rows, embed, write back, recall. Gated on VOYAGE_API_KEY so
  // the smoke stays runnable without provider creds.
  // ---------------------------------------------------------------------
  if (!process.env.VOYAGE_API_KEY) {
    console.log("[smoke] 12. skipped — VOYAGE_API_KEY unset");
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
      `[smoke] 12. embed+recall ok (similarity=${ourHit.similarity.toFixed(3)}, hits=${hits.length})`,
    );
  }

  console.log("\n[smoke] PASS");
}

main()
  .catch((err) => {
    console.error("[smoke] FAIL", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAgentQueue().catch(() => {});
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });
