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
 * Body retention for `event_receipts`, asserted against a real database.
 *
 * NOT a feature test. This pins a predicate, and the two ways that predicate can
 * be wrong are both invisible from outside the module: a pass that releases
 * nothing looks exactly like a pass that works, and a pass that releases too much
 * destroys data without raising. No compiler and no boundary parse sees either,
 * and CLAUDE.md's bar — "a check that lies" — is met by a retention pass that
 * under-reaps.
 *
 * The reaper is not user-scoped, so a pass releases every eligible row in the
 * table and not only the rows its caller seeded. A case that asserts the pass's
 * return value is therefore reading a global count, and two things make that
 * count a per-case fact: `caseClock` gives each case a cutoff window no other
 * case's rows fall inside, and `CLOCK` keeps that window in year 2000, ahead of
 * every real row in the shared dev database. The cases that do not need a count
 * read their own ids back by name. There is no case left that runs the scheduled
 * pass, because the scheduler holds no injectable clock — `runOnStart` would
 * read the shared dev database at the real wall clock, and
 * `periodic-task.test.ts` already covers idempotent start and a restartable
 * stop against the scheduler itself.
 *
 * The seeded rows differ from the one that may be released in EXACTLY ONE
 * dimension each — age, processing status, tier, or the presence of a corpus
 * document — which is what makes each assertion a statement about its own clause
 * rather than about the conjunction.
 */

const SKIP = dbBackedSkip("database");

const HOUR_MS = 60 * 60 * 1000;

const DAY_MS = 24 * HOUR_MS;

/**
 * The base clock, fixed in year 2000.
 *
 * `deliveredAt` has to be relative to something, and `new Date()` is the
 * obvious choice and the wrong one: seeding relative to the wall clock puts THIS
 * file's rows 90+ days in the past while leaving the reaper free to release
 * every real receipt in the shared dev database that is also past 90 days. A
 * pass would then take page slots, counts and abort placement from rows this
 * file never saw, and the suite's verdict would depend on the order the cases
 * ran in — which is the "check that lies" this file exists to avoid,
 * reintroduced one level up.
 *
 * Anchored in 2000, every cutoff in this file precedes every real row, so the
 * only releasable rows in the database are the ones a case seeded.
 */
const CLOCK = new Date("2000-01-01T00:00:00.000Z");

/**
 * The clock for the next case: `CLOCK` stepped back a day per call.
 *
 * A pass releases every eligible row older than its cutoff, across the whole
 * table, not just the rows the case that asked for the pass seeded. Two cases
 * sharing one cutoff therefore share one page, and a case asserting a return
 * value reads a count the case before it left behind — which is how the abort
 * case's four survivors and the race case's `released === 1` were two facts
 * about file order rather than about the reaper. Stepping each case a day
 * FURTHER BACK gives every case a cutoff older than the rows of every case
 * before it, so an earlier case's rows sit above a later pass's cutoff and are
 * out of its reach, and each count is a per-case fact.
 *
 * The step is a day against rows seeded an hour past their own cutoff, so the
 * windows do not touch. Which offset a case gets depends on how many cases ran
 * before it, so filtering the file with `--test-name-pattern` moves the offsets
 * without moving the spacing: the verdict is a function of the spacing, not of
 * any case's position in a full run.
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

    // Aborted AFTER the first batch. `releaseExpiredReceiptPayloadsOnce` reads
    // `signal.aborted` once per iteration, so a signal that reports false
    // exactly once proves the check sits BETWEEN batches: a check placed before
    // the loop releases nothing, and no check at all releases all six. These
    // bounds are exact rather than ranged because this case's own cutoff window
    // (`caseClock`) holds no row another case seeded.
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

    // Both calls start before either awaits a round trip, so the guard is
    // exercised deterministically. Without it both passes would select the same
    // id page and the loser would hold a pool connection to release nothing.
    const [first, second] = await Promise.all([
      releaseExpiredReceiptPayloadsOnce(now),
      releaseExpiredReceiptPayloadsOnce(now),
    ]);

    // Both counts are exact because this case's cutoff window holds only the one
    // row above: the winner releases it, and the loser releases nothing.
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

    // The redelivery's conflict target, not the handler's whole insert: what is
    // under test is that `(provider, provider_delivery_id)` still conflicts after
    // a release, so the extra columns the handler sets (`payloadHash`, and the
    // document it writes in the same transaction) are omitted rather than
    // restated here. A provider chooses the age at which it repeats a delivery,
    // and this conflict has to hold at whatever age it chooses — which is the
    // whole reason a release may not delete the row.
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

    // The row the reaper will select, and the row it must leave alone. Both are
    // releasable by every other clause; the only difference between them is what
    // the other session does while the reaper is blocked.
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

    // Reproduces the review's sequence on the real trigger rather than arguing
    // it. A second session holds an open transaction that has marked the row
    // `failed` but not committed, so the reaper's page still sees it as
    // `completed` and then parks on the row lock. On commit the reaper's
    // `UPDATE` wakes and Postgres re-checks the row against the OUTER `WHERE`
    // through EvalPlanQual: the page is an InitPlan fixed before the wait, so
    // only the outer clauses can catch this.
    //
    // The commit is sent on the holder's OWN connection, and that is the point:
    // the holder is not blocked, so its transaction can be committed while the
    // reaper is still waiting. Nothing needs a third session.
    //
    // It is the control row that proves the pass did work. A pass that released
    // nothing would pass this case for the wrong reason.
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
      // Observe the reaper parked rather than sleeping for a guessed interval: a
      // fixed wait that expires early lets the reaper's statement commit after
      // this one, and the case then passes with the outer clause deleted.
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
 * Resolve once a backend in this database is waiting on a lock.
 *
 * `pg_locks`, and specifically `pg_stat_activity` as the obvious alternative
 * does NOT work here: both report the waiter correctly from an outside session,
 * but the holder runs this poll inside its own open transaction, and from there
 * the waiting backend is absent from `pg_stat_activity` entirely while
 * `pg_locks` reports it. That was measured on the same blocked `UPDATE` rather
 * than assumed, and it is why the poll asks about locks and not about backends.
 *
 * A server-reported wait beats a guessed interval: a fixed sleep either wastes
 * time or expires before the pass reaches its statement, and on a slow machine
 * the expiry lets the commit win, after which the outer `processing_status`
 * clause is never exercised and the case passes for the wrong reason. A timeout
 * here fails loudly rather than passing quietly.
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
