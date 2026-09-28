import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { eventTypeName, rawEventTypeName } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import type { SealedCredentialSecret } from "@alfred/db/credential-vault";
import { documents, eventReceipts, integrationCredentials, user } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";

import {
  isReceiptPayloadReaperRunning,
  MAX_BATCHES_PER_PASS,
  RECEIPT_PAYLOAD_RETENTION_MS,
  RELEASE_BATCH_SIZE,
  releaseExpiredReceiptPayloadsOnce,
  startReceiptPayloadReaper,
  stopReceiptPayloadReaper,
} from "../../../src/connections/ingestion/receipt-payload-reaper";
import { receiptDocumentKey } from "../../../src/connections/ingestion/receipt-document";
import { dbBackedSkip } from "../../support/db-backed";

/**
 * Body retention for `event_receipts`, asserted against a real database.
 *
 * NOT a feature test. This pins a predicate, and the two ways that predicate can
 * be wrong are both invisible from outside the module: a pass that releases
 * nothing looks exactly like a pass that works, and a pass that releases too much
 * destroys data without raising. No compiler and no boundary parse sees either,
 * and CLAUDE.md's bar — "a check that lies" — is met by a retention pass that
 * under-reaps.
 *
 * The reaper is not user-scoped, so every case reads back the ids it seeded by
 * name rather than asserting a global count. The one exception is the paging
 * case, which is exact because only these rows can be releasable: a receipt
 * enters the index with `payload` set, a document is written in the same
 * transaction that inserts it, and a test that stores a body without a document
 * is excluded by the `EXISTS` clause.
 *
 * The seeded rows differ from the one that may be released in EXACTLY ONE
 * dimension each — age, processing status, tier, or the presence of a corpus
 * document — which is what makes each assertion a statement about its own clause
 * rather than about the conjunction.
 */

const SKIP = dbBackedSkip("database");

const HOUR_MS = 60 * 60 * 1000;

const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `reaper-receipt-${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Receipt Payload Reaper", email: `${userId}@example.test` });

  return userId;
}

async function seedCredential(userId: string): Promise<string> {
  const [row] = await db()
    .insert(integrationCredentials)
    .values({
      userId,
      provider: "github",
      accountId: `${userId}-gh`,
      // Deliberate unsealed write: nothing in this file opens the token; the row
      // exists only so the receipt has a credential to point at.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- boundary cast: source type is structurally incompatible with target
      accessToken: "test-token" as unknown as SealedCredentialSecret,
      installationId: "1",
      status: "active",
    })
    .returning({ id: integrationCredentials.id });

  if (!row) throw new Error("credential insert returned no row");

  return row.id;
}

/** The body a released row would lose, and the one its document keeps. */
const BODY = {
  action: "closed",
  repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
};

/** One receipt, on the columns the receive path inserts, plus its corpus document. */
async function seedReceipt(args: {
  userId: string;
  credentialId: string;
  deliveredAt: Date;
  processingStatus: "pending" | "completed" | "failed";
  rawKind?: string;
  withDocument?: boolean;
}): Promise<string> {
  const payloadHash = randomUUID().replaceAll("-", "");
  const provider = "github" as const;

  const providerDeliveryId = args.rawKind
    ? `raw:${args.rawKind}:${payloadHash}`
    : `delivery-${randomUUID()}`;

  const [row] = await db()
    .insert(eventReceipts)
    .values({
      provider,
      providerDeliveryId,
      credentialId: args.credentialId,
      userId: args.userId,
      eventType: args.rawKind ? rawEventTypeName(provider) : eventTypeName(provider, "push"),
      ...(args.rawKind ? { rawKind: args.rawKind } : {}),
      verificationResult: "signature_valid",
      payloadHash,
      historyId: "9001",
      payload: BODY,
      processingStatus: args.processingStatus,
      deliveredAt: args.deliveredAt,
    })
    .returning({ id: eventReceipts.id });

  if (!row) throw new Error("receipt insert returned no row");

  // Under the key the reaper's `receiptDocumentJoin` reads, built by the same
  // helper the writer uses, so a re-key cannot make this suite pass against a
  // join that no longer matches.
  if (args.withDocument !== false) {
    await db()
      .insert(documents)
      .values({
        ...receiptDocumentKey({ id: row.id, userId: args.userId, provider }),
        accountId: `${args.userId}-gh`,
        title: "PR closed",
        content: "a closed pull request",
        contentHash: payloadHash,
        raw: BODY,
        authoredAt: args.deliveredAt,
      });
  }

  return row.id;
}

async function readReceipts(ids: string[]) {
  return db()
    .select({
      id: eventReceipts.id,
      payload: eventReceipts.payload,
      payloadHash: eventReceipts.payloadHash,
      deliveredAt: eventReceipts.deliveredAt,
      historyId: eventReceipts.historyId,
      processingStatus: eventReceipts.processingStatus,
      provider: eventReceipts.provider,
      providerDeliveryId: eventReceipts.providerDeliveryId,
      updatedAt: eventReceipts.updatedAt,
    })
    .from(eventReceipts)
    .where(inArray(eventReceipts.id, ids));
}

/** Which of `ids` still hold a body. */
async function withBody(ids: string[]): Promise<Set<string>> {
  const rows = await readReceipts(ids);

  return new Set(rows.filter((r) => r.payload !== null).map((r) => r.id));
}

async function readOne(id: string) {
  const [row] = await readReceipts([id]);
  assert.ok(row, `receipt ${id} must still exist — a release never deletes a row`);

  return row;
}

/** One hour past the window, and one hour short of it. */
function ages(now: Date) {
  return {
    expired: new Date(now.getTime() - RECEIPT_PAYLOAD_RETENTION_MS - HOUR_MS),
    inWindow: new Date(now.getTime() - RECEIPT_PAYLOAD_RETENTION_MS + HOUR_MS),
  };
}

describe("event_receipts payload retention", { skip: SKIP }, () => {
  after(async () => {
    // A cascade from the seeded user, which is the one DELETE path the
    // append-only trigger allows (`pg_trigger_depth() > 1`). A direct DELETE of
    // a receipt is refused, which is what the item 01 trigger probe pins.
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    await closeConnections();
  });

  test("releases an expired completed body, and every column that makes the row valuable", async () => {
    const now = new Date();
    const userId = await seedUser();
    const credentialId = await seedCredential(userId);
    const { expired } = ages(now);

    const releasable = await seedReceipt({
      userId,
      credentialId,
      deliveredAt: expired,
      processingStatus: "completed",
    });

    const before = await readOne(releasable);
    assert.ok(before.payload !== null, "the seeded row starts with a body");

    await releaseExpiredReceiptPayloadsOnce(now);

    const after = await readOne(releasable);
    assert.equal(after.payload, null, "an expired completed body is released");
    // The receipt outlives its body. The dedup key, the gap-detection cursor, the
    // verification hash, the delivery time and the processing audit are the
    // reason the row is kept at all.
    assert.equal(after.provider, before.provider);
    assert.equal(after.providerDeliveryId, before.providerDeliveryId);
    assert.equal(after.historyId, before.historyId);
    assert.equal(after.payloadHash, before.payloadHash);
    assert.equal(after.processingStatus, before.processingStatus);
    assert.equal(after.deliveredAt?.getTime(), before.deliveredAt?.getTime());
  });

  test("keeps a body inside the window, and a failed one, and a pending one, and an unprojected one", async () => {
    const now = new Date();
    const userId = await seedUser();
    const credentialId = await seedCredential(userId);
    const { expired, inWindow } = ages(now);

    // Each row differs from the releasable one in exactly one dimension.
    const fresh = await seedReceipt({
      userId,
      credentialId,
      deliveredAt: inWindow,
      processingStatus: "completed",
    });

    const failed = await seedReceipt({
      userId,
      credentialId,
      deliveredAt: expired,
      processingStatus: "failed",
    });

    const pending = await seedReceipt({
      userId,
      credentialId,
      deliveredAt: expired,
      processingStatus: "pending",
    });

    const unprojected = await seedReceipt({
      userId,
      credentialId,
      deliveredAt: expired,
      processingStatus: "completed",
      withDocument: false,
    });

    await releaseExpiredReceiptPayloadsOnce(now);

    const alive = await withBody([fresh, failed, pending, unprojected]);
    // `processing_status = 'completed'`, not `<> 'failed'`: a redelivery
    // re-enqueues any non-completed receipt at any age, and the deliver job
    // publishes a pointer the object-state fold resolves by reading the body.
    assert.equal(alive.has(failed), true, "a failed receipt's body is still owed to its retry");
    assert.equal(alive.has(pending), true, "a pending receipt is re-enqueued on redelivery too");
    // The corpus backfill builds a receipt's document FROM the body, and that
    // projection is unrecoverable afterwards, so a receipt with no document
    // waits for the backfill rather than racing it.
    assert.equal(alive.has(unprojected), true, "a receipt with no corpus document keeps its body");
    assert.equal(alive.has(fresh), true, "only age separates a fresh row from a released one");
  });

  test("releases a raw receipt's body too, not only the typed tier", async () => {
    const now = new Date();
    const userId = await seedUser();
    const credentialId = await seedCredential(userId);
    const { expired } = ages(now);

    const raw = await seedReceipt({
      userId,
      credentialId,
      deliveredAt: expired,
      processingStatus: "completed",
      rawKind: "comment.created",
    });

    await releaseExpiredReceiptPayloadsOnce(now);

    assert.equal(
      (await withBody([raw])).size,
      0,
      "raw receipts carry bodies on the same growth curve; leaving them would be the same bug, smaller",
    );
  });

  test("a second pass over released rows is a no-op, and the cutoff moves with the clock", async () => {
    const now = new Date();
    const userId = await seedUser();
    const credentialId = await seedCredential(userId);
    const { expired, inWindow } = ages(now);

    const releasable = await seedReceipt({
      userId,
      credentialId,
      deliveredAt: expired,
      processingStatus: "completed",
    });

    const fresh = await seedReceipt({
      userId,
      credentialId,
      deliveredAt: inWindow,
      processingStatus: "completed",
    });

    const ids = [releasable, fresh];

    await releaseExpiredReceiptPayloadsOnce(now);
    const afterFirst = await withBody(ids);
    assert.equal(afterFirst.has(releasable), false);
    assert.equal(afterFirst.has(fresh), true);

    // Nothing to do the second time round. The row is not deleted by the first
    // pass, it simply leaves the partial index, so there is no second entry to
    // release. `updated_at` is the observable for that: `payload IS NOT NULL` is
    // what drops the row out of `event_receipts_payload_live_idx`, and without
    // it a released row is re-selected and rewritten every hour forever, bumping
    // `updated_at` and leaving a dead tuple each time. The sleep is there
    // because `$onUpdate` sends a JS Date, so two writes inside one millisecond
    // are indistinguishable.
    const updatedAfterFirst = (await readOne(releasable)).updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await releaseExpiredReceiptPayloadsOnce(now);
    assert.deepEqual([...(await withBody(ids))].sort(), [fresh]);
    assert.equal(
      (await readOne(releasable)).updatedAt?.getTime(),
      updatedAfterFirst?.getTime(),
      "a released row is out of the predicate, so a later pass must not rewrite it",
    );

    // A clock two hours later puts `fresh` past the cutoff too. If the cutoff
    // were hard-coded, or `now` ignored, this row would keep its body and the
    // case would fail.
    await releaseExpiredReceiptPayloadsOnce(new Date(now.getTime() + 2 * HOUR_MS));
    assert.equal((await withBody(ids)).size, 0);
  });

  test("a pass stops at maxBatches * batchSize and leaves the rest for the next pass", async () => {
    const now = new Date();
    const userId = await seedUser();
    const credentialId = await seedCredential(userId);
    const { expired } = ages(now);

    const ids: string[] = [];

    for (let i = 0; i < 5; i += 1) {
      ids.push(
        await seedReceipt({
          userId,
          credentialId,
          // Distinct ages, so the drain order is the delivery order the page is
          // ordered by rather than an accident of equal timestamps.
          deliveredAt: new Date(expired.getTime() + i * 1000),
          processingStatus: "completed",
        }),
      );
    }

    await releaseExpiredReceiptPayloadsOnce(now, { batchSize: 2, maxBatches: 2 });

    assert.equal(
      (await withBody(ids)).size,
      1,
      "2 batches of 2 must stop at 4 of 5 rather than drain all of them",
    );

    // The next pass picks up where this one stopped — that is what makes the cap
    // a spread rather than a leak.
    await releaseExpiredReceiptPayloadsOnce(now, { batchSize: 2, maxBatches: 2 });
    assert.equal((await withBody(ids)).size, 0);
  });

  test("the shipped bounds are 1,000 rows over 20 batches", () => {
    // 20,000 bodies an hour. The batch size is the measured page cliff, not a
    // round number: the EXISTS clause abandons `event_receipts_payload_live_idx`
    // past it, which would undo the index item 01 exists for.
    assert.equal(RELEASE_BATCH_SIZE, 1_000);
    assert.equal(MAX_BATCHES_PER_PASS, 20);
  });

  test("an aborted signal stops the pass between batches", async () => {
    const now = new Date();
    const userId = await seedUser();
    const credentialId = await seedCredential(userId);
    const { expired } = ages(now);

    const ids: string[] = [];

    for (let i = 0; i < 6; i += 1) {
      ids.push(
        await seedReceipt({
          userId,
          credentialId,
          deliveredAt: new Date(expired.getTime() + i * 1000),
          processingStatus: "completed",
        }),
      );
    }

    // Aborted before the first batch: nothing may be released at all.
    const upfront = new AbortController();
    upfront.abort();

    const skipped = await releaseExpiredReceiptPayloadsOnce(now, {
      batchSize: 2,
      signal: upfront.signal,
    });

    assert.equal(skipped, 0);
    assert.equal((await withBody(ids)).size, 6, "an already-aborted pass must not release");

    // Aborted AFTER the first batch. `releaseExpiredReceiptPayloadsOnce` reads
    // `signal.aborted` once per iteration, so a signal that reports false
    // exactly once proves the check sits BETWEEN batches: a check placed before
    // the loop releases nothing, and no check at all releases all six. The
    // bounds are loose because the database is shared and a foreign eligible row
    // could take a page slot; the placement is what is under test.
    const released = await releaseExpiredReceiptPayloadsOnce(now, {
      batchSize: 2,
      signal: signalAbortingAfterReads(1),
    });

    assert.ok(released >= 1, "the first batch runs before the abort is noticed");
    assert.ok(released <= 2, "no second batch may start after the abort");
    assert.ok(
      (await withBody(ids)).size >= 4,
      "at most one batch of the six seeded bodies may be released",
    );
  });

  test("a second concurrent pass yields instead of racing the first", async () => {
    const now = new Date();
    const userId = await seedUser();
    const credentialId = await seedCredential(userId);
    const { expired } = ages(now);

    const releasable = await seedReceipt({
      userId,
      credentialId,
      deliveredAt: expired,
      processingStatus: "completed",
    });

    // Both calls start before either awaits a round trip, so the guard is
    // exercised deterministically. Without it both passes would select the same
    // id page and the loser would hold a pool connection to release nothing.
    const [first, second] = await Promise.all([
      releaseExpiredReceiptPayloadsOnce(now),
      releaseExpiredReceiptPayloadsOnce(now),
    ]);

    assert.equal(second, 0, "the second caller must yield — the guard is on the entrypoint");
    assert.ok(first >= 1, "the first caller still does the work");
    assert.equal((await withBody([releasable])).size, 0);
  });

  test("a redelivery of a released receipt is still a no-op", async () => {
    const now = new Date();
    const userId = await seedUser();
    const credentialId = await seedCredential(userId);
    const { expired } = ages(now);

    const releasable = await seedReceipt({
      userId,
      credentialId,
      deliveredAt: expired,
      processingStatus: "completed",
    });

    const { provider, providerDeliveryId } = await readOne(releasable);
    await releaseExpiredReceiptPayloadsOnce(now);
    assert.equal((await readOne(releasable)).payload, null, "the body is released");

    // The insert the webhook handler performs, verbatim. GitHub's redelivery
    // button works on months-old deliveries, so this conflict is the whole
    // reason a release may not delete the row.
    const inserted = await db()
      .insert(eventReceipts)
      .values({
        provider,
        providerDeliveryId,
        credentialId,
        userId,
        eventType: eventTypeName("github", "push"),
        verificationResult: "signature_valid",
        payload: BODY,
        processingStatus: "pending",
        deliveredAt: new Date(),
      })
      .onConflictDoNothing({ target: [eventReceipts.provider, eventReceipts.providerDeliveryId] })
      .returning({ id: eventReceipts.id });

    assert.deepEqual(
      inserted,
      [],
      "the dedup key outlives the body, so redelivery inserts nothing",
    );

    const rows = await db()
      .select({ id: eventReceipts.id })
      .from(eventReceipts)
      .where(
        and(
          eq(eventReceipts.provider, provider),
          eq(eventReceipts.providerDeliveryId, providerDeliveryId),
        ),
      );

    assert.equal(rows.length, 1, "the redelivery did not become a second receipt");
  });

  test("start is idempotent and stop leaves the reaper restartable", async () => {
    assert.equal(isReceiptPayloadReaperRunning(), false, "not running before start");

    startReceiptPayloadReaper();
    startReceiptPayloadReaper();
    assert.equal(isReceiptPayloadReaperRunning(), true);

    await stopReceiptPayloadReaper();
    assert.equal(isReceiptPayloadReaperRunning(), false);

    // A restart must work: `runtime.ts` starts and stops this on every boot, and
    // an AbortSignal cannot be un-aborted.
    startReceiptPayloadReaper();
    assert.equal(isReceiptPayloadReaperRunning(), true);
    await stopReceiptPayloadReaper();
    assert.equal(isReceiptPayloadReaperRunning(), false);
  });
});

/**
 * A signal that reports "not aborted" for its first `reads` reads and aborted
 * after.
 *
 * A plain `AbortController` cannot express "abort between batch 1 and batch 2"
 * without a race, and the placement of the check is precisely what is under
 * test. Only `aborted` is overridden, so every other member still behaves like
 * the real signal it proxies.
 */
function signalAbortingAfterReads(reads: number): AbortSignal {
  const controller = new AbortController();
  let seen = 0;

  return new Proxy(controller.signal, {
    get(target, prop, receiver) {
      if (prop === "aborted") return seen++ >= reads;
      const value = Reflect.get(target, prop, receiver);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
