import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { eventTypeName, rawEventTypeName } from "@alfred/contracts";
import { closeConnections, db, withDbSession } from "@alfred/db";
import type { SealedCredentialSecret } from "@alfred/db/credential-vault";
import type { EventReceipt } from "@alfred/db/schemas";
import { documents, eventReceipts, integrationCredentials, user } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";

import {
  RECEIPT_PAYLOAD_RETENTION_MS,
  releaseExpiredReceiptPayloadsOnce,
} from "../../../src/connections/ingestion/receipt-payload-reaper";
import { receiptDocumentKey } from "../../../src/connections/ingestion/receipt-document";
import { dbBackedSkip } from "../../support/db-backed";

/**
 * Body retention for `event_receipts`, against a real database.
 * A pass that releases nothing, or too much, fails silently, so this pins the predicate.
 * The reaper is not user-scoped. `caseClock` gives each case its own cutoff window.
 * Each seeded row differs from the releasable row in exactly one dimension.
 * No case runs the scheduled pass: the scheduler has no injectable clock.
 */

const SKIP = dbBackedSkip("database");

const HOUR_MS = 60 * 60 * 1000;

const DAY_MS = 24 * HOUR_MS;

/** Year 2000, so every cutoff here precedes every real row in the shared dev database. */
const CLOCK = new Date("2000-01-01T00:00:00.000Z");

/**
 * `CLOCK` stepped back one day per call, so each case has its own cutoff window.
 * Rows sit one hour past their cutoff, so the windows never overlap.
 */
let clockStep = 0;

function caseClock(): Date {
  const now = new Date(CLOCK.getTime() - clockStep * DAY_MS);
  clockStep += 1;

  return now;
}

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
      // Deliberate unsealed write: nothing here opens the token.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions -- boundary cast: source type is structurally incompatible with target
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
  processingStatus: EventReceipt["processingStatus"];
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

  // The key the reaper's `receiptDocumentJoin` reads, built by the writer's own helper.
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
    // A cascade from the user is the only DELETE the append-only trigger allows (`pg_trigger_depth() > 1`).
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    await closeConnections();
  });

  test("releases an expired completed body, and every column that makes the row valuable", async () => {
    const now = caseClock();
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
    // The row stays: the dedup key, cursor, verification hash, and audit live on it.
    assert.equal(after.provider, before.provider);
    assert.equal(after.providerDeliveryId, before.providerDeliveryId);
    assert.equal(after.historyId, before.historyId);
    assert.equal(after.payloadHash, before.payloadHash);
    assert.equal(after.processingStatus, before.processingStatus);
    assert.equal(after.deliveredAt?.getTime(), before.deliveredAt?.getTime());
  });

  test("keeps a body inside the window, and a failed one, and a pending one, and an unprojected one", async () => {
    const now = caseClock();
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
    // `completed`, not `<> 'failed'`: a redelivery re-enqueues any non-completed receipt, and the fold reads the body.
    assert.equal(alive.has(failed), true, "a failed receipt's body is still owed to its retry");
    assert.equal(alive.has(pending), true, "a pending receipt is re-enqueued on redelivery too");
    // The corpus backfill builds the document from the body, so a receipt with no document waits.
    assert.equal(alive.has(unprojected), true, "a receipt with no corpus document keeps its body");
    assert.equal(alive.has(fresh), true, "only age separates a fresh row from a released one");
  });

  test("releases a raw receipt's body too, not only the typed tier", async () => {
    const now = caseClock();
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
    const now = caseClock();
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

    // A released row leaves `event_receipts_payload_live_idx`, so a second pass must not rewrite it.
    // The sleep: `$onUpdate` sends a JS Date, so two writes in one millisecond look the same.
    const updatedAfterFirst = (await readOne(releasable)).updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await releaseExpiredReceiptPayloadsOnce(now);
    assert.deepEqual([...(await withBody(ids))].sort(), [fresh]);
    assert.equal(
      (await readOne(releasable)).updatedAt?.getTime(),
      updatedAfterFirst?.getTime(),
      "a released row is out of the predicate, so a later pass must not rewrite it",
    );

    // Two hours later, `fresh` is past the cutoff too. This fails if `now` is ignored.
    await releaseExpiredReceiptPayloadsOnce(new Date(now.getTime() + 2 * HOUR_MS));
    assert.equal((await withBody(ids)).size, 0);
  });

  test("a pass stops at maxBatches * batchSize and leaves the rest for the next pass", async () => {
    const now = caseClock();
    const userId = await seedUser();
    const credentialId = await seedCredential(userId);
    const { expired } = ages(now);

    const ids: string[] = [];

    for (let i = 0; i < 5; i += 1) {
      ids.push(
        await seedReceipt({
          userId,
          credentialId,
          // Distinct ages, so the drain order is the delivery order.
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

    // The next pass resumes where this one stopped, so the cap delays and does not leak.
    await releaseExpiredReceiptPayloadsOnce(now, { batchSize: 2, maxBatches: 2 });
    assert.equal((await withBody(ids)).size, 0);
  });

  test("an aborted signal stops the pass between batches", async () => {
    const now = caseClock();
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

    // Aborted after the first batch. A signal that reads false once proves the check sits between batches.
    // Exact bounds hold because `caseClock` keeps other cases' rows out of this window.
    const released = await releaseExpiredReceiptPayloadsOnce(now, {
      batchSize: 2,
      signal: signalAbortingAfterReads(1),
    });

    assert.equal(released, 2, "the first batch runs before the abort is noticed");
    assert.equal(
      (await withBody(ids)).size,
      4,
      "no second batch may start after the abort, so four of the six survive",
    );
  });

  test("a second concurrent pass yields instead of racing the first", async () => {
    const now = caseClock();
    const userId = await seedUser();
    const credentialId = await seedCredential(userId);
    const { expired } = ages(now);

    const releasable = await seedReceipt({
      userId,
      credentialId,
      deliveredAt: expired,
      processingStatus: "completed",
    });

    // Both calls start before either awaits, so the in-flight guard runs deterministically.
    const [first, second] = await Promise.all([
      releaseExpiredReceiptPayloadsOnce(now),
      releaseExpiredReceiptPayloadsOnce(now),
    ]);

    // This window holds one row: the winner releases it and the loser releases nothing.
    assert.equal(second, 0, "the second caller must yield — the guard is on the entrypoint");
    assert.equal(first, 1, "the first caller still does the work");
    assert.equal((await withBody([releasable])).size, 0);
  });

  test("a redelivery of a released receipt is still a no-op", async () => {
    const now = caseClock();
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

    // Only the conflict target. `(provider, provider_delivery_id)` must still conflict after a release,
    // at any redelivery age. That is why a release keeps the row.
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

  test("a row that fails delivery while the pass waits for its lock keeps its body", async () => {
    const now = caseClock();
    const userId = await seedUser();
    const credentialId = await seedCredential(userId);
    const { expired } = ages(now);

    // Both rows are releasable. Only the other session's write differs.
    const racing = await seedReceipt({
      userId,
      credentialId,
      deliveredAt: expired,
      processingStatus: "completed",
    });

    const control = await seedReceipt({
      userId,
      credentialId,
      deliveredAt: new Date(expired.getTime() + 1000),
      processingStatus: "completed",
    });

    // A second session marks the row `failed` without commit, so the reaper's page sees `completed` and waits on the lock.
    // On commit, EvalPlanQual re-checks only the outer `WHERE` (the page is a fixed InitPlan).
    // The holder is not blocked, so it commits on its own connection.
    // The control row proves the pass did work.
    let holdLock: () => void;

    const locked = new Promise<void>((resolve) => {
      holdLock = resolve;
    });

    const holder = withDbSession(async ({ db: session, client }) => {
      await client.query("BEGIN");
      await session
        .update(eventReceipts)
        .set({ processingStatus: "failed" })
        .where(eq(eventReceipts.id, racing));
      holdLock();
      // Wait for the lock, not a fixed sleep: an early expiry lets the case pass with the outer clause deleted.
      await waitUntilBlockedOn(client);
      await client.query("COMMIT");
    });

    await locked;
    const released = await releaseExpiredReceiptPayloadsOnce(now);
    await holder;

    assert.equal(released, 1, "the control row is released, so the pass ran; the raced row is not");
    assert.equal(
      (await withBody([racing])).size,
      1,
      "a receipt marked failed while the pass waited keeps its body: its retry still needs it",
    );
    assert.equal(
      (await withBody([control])).size,
      0,
      "the other row in the same page was released, so this is the race clause and not an empty page",
    );
  });
});

/**
 * Resolve once a backend in this database waits on a lock.
 * Uses `pg_locks`: inside the holder's open transaction, `pg_stat_activity` does not show the waiter.
 */
async function waitUntilBlockedOn(client: {
  query: (sql: string) => Promise<unknown>;
}): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const result = (await client.query(
      "select exists (select 1 from pg_locks l where not l.granted and pg_backend_pid() = any (pg_blocking_pids(l.pid))) as blocked",
    )) as { rows: { blocked: boolean }[] };

    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("no backend blocked on the holder's row lock within 10s");
}

/**
 * A signal that reads "not aborted" for its first `reads` reads, then aborted.
 * A plain `AbortController` cannot abort between batch 1 and batch 2 without a race.
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
