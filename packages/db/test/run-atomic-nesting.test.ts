import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { closeConnections, db, rowsFromExecute } from "@alfred/db";
import { runAtomic, type DbRunner } from "@alfred/db/helpers";
import { pgErrorChain } from "@alfred/db/pg-errors";
import { sql } from "drizzle-orm";

import { dbBackedSkip } from "./support/db-backed";

/**
 * DB-backed guard for the nesting contract of `runAtomic` (campaign item 131).
 *
 * `runAtomic` used to read `"transaction" in runner ? runner.transaction(body) :
 * body(runner)`. The condition is ALWAYS true — both members of `DbRunner` carry
 * `transaction` — so the second arm never ran and the helper always opened a
 * transaction, which Postgres serves as a `SAVEPOINT` when one is already open.
 * Deleting the dead arm keeps that behavior; this file is what makes the choice
 * a decision instead of an accident.
 *
 * The load-bearing assertion is `rowsAfterFailure`, and it discriminates two
 * ways at once. Under savepoint semantics the read ANSWERS, and it answers `0`.
 * Under the reuse semantics the deleted arm would have given (`body(runner)`),
 * either the read returns a NON-ZERO count — measured: `1`, because a body that
 * throws in JavaScript has no savepoint to roll back to, so its writes stay live
 * in the caller's transaction — or, when the body fails with a SQL error instead,
 * the caller's transaction is aborted and the same read raises SQLSTATE `25P02`.
 * A test that only called `runAtomic` with the root client cannot tell the two
 * designs apart.
 *
 * Needs a reachable migrated Postgres — locally, `docker compose up postgres`.
 * The `db-tests` CI job supplies one; `dbBackedSkip` throws there rather than
 * skipping if it does not.
 */
const SKIP = dbBackedSkip("database");

/** Thrown by the inner body, to fail it for a reason the test controls. */
class InnerFailure extends Error {
  constructor() {
    super("run-atomic-nesting: deliberate inner failure");
    this.name = "InnerFailure";
  }
}

/** Thrown at the end of the outer transaction so the probe leaves no residue. */
class RollbackSentinel extends Error {
  constructor() {
    super("run-atomic-nesting: deliberate outer rollback");
    this.name = "RollbackSentinel";
  }
}

/**
 * The transaction id of the runner's CURRENT transaction. `txid_current()`
 * assigns one if the transaction does not have it yet, so two calls inside one
 * transaction agree and two separate transactions do not. Postgres returns a
 * bigint, which node-postgres hands back as a string.
 */
async function currentTxid(runner: DbRunner): Promise<string> {
  const result = await runner.execute(sql`select txid_current()::text as txid`);
  const [row] = rowsFromExecute<{ txid: string }>(result);
  assert.ok(row, "txid_current() returned no row");
  return row.txid;
}

/** The first SQLSTATE in the error's wrapped `.cause` chain, or `null`. */
function sqlState(err: unknown): string | null {
  for (const level of pgErrorChain(err)) {
    if (level.code) return level.code;
  }
  return null;
}

describe("runAtomic nesting semantics", { skip: SKIP }, () => {
  after(async () => {
    await closeConnections();
  });

  test("a nested body failure rolls back to a savepoint and leaves the outer transaction usable", async () => {
    // Every observation is collected inside the outer transaction and asserted
    // outside it: an assertion that throws in there would unwind the
    // transaction and be reported as the outer rejection, hiding which fact
    // actually failed.
    const seen: {
      outerTxid?: string;
      innerTxid?: string;
      innerRejection?: string;
      /** The row count after the inner failure, or the SQLSTATE the read raised. */
      rowsAfterFailure?: number | string;
    } = {};

    await assert.rejects(
      db().transaction(async (outer) => {
        // Session-scoped, and `db()` is pooled — this holds only because one
        // `transaction` callback runs every statement on one checked-out
        // client. `ON COMMIT DROP` cleans up even on the paths that commit.
        await outer.execute(
          sql`create temp table run_atomic_probe (id int primary key) on commit drop`,
        );
        seen.outerTxid = await currentTxid(outer);

        try {
          await runAtomic(outer, async (inner) => {
            await inner.execute(sql`insert into run_atomic_probe (id) values (1)`);
            seen.innerTxid = await currentTxid(inner);
            throw new InnerFailure();
          });
        } catch (err) {
          seen.innerRejection = err instanceof Error ? err.name : String(err);
        }

        // The discriminator. Under savepoint semantics this answers `0`; under
        // reuse it answers a non-zero count, or raises `25P02` when the inner
        // body failed with a SQL error rather than a JavaScript throw.
        try {
          const result = await outer.execute(sql`select count(*)::int as n from run_atomic_probe`);
          const [row] = rowsFromExecute<{ n: number }>(result);
          seen.rowsAfterFailure = row?.n ?? -1;
        } catch (err) {
          seen.rowsAfterFailure = sqlState(err) ?? `non-sqlstate: ${String(err)}`;
        }

        throw new RollbackSentinel();
      }),
      RollbackSentinel,
    );

    assert.equal(
      seen.innerRejection,
      "InnerFailure",
      "the inner rejection must propagate unchanged",
    );
    assert.ok(seen.outerTxid, "the outer transaction reported no txid");
    assert.equal(
      seen.innerTxid,
      seen.outerTxid,
      "nesting opened a SECOND transaction — the outermost transaction is no longer the single commit unit",
    );
    assert.equal(
      seen.rowsAfterFailure,
      0,
      `the outer transaction must stay usable and see none of the failed body's writes; got ${String(seen.rowsAfterFailure)}. A non-zero COUNT means the failed body's writes are still live in the caller's transaction — there was no savepoint to roll back to. A SQLSTATE means the read itself was refused, so the inner failure aborted the caller's transaction. Both are the reuse semantics this helper deliberately does not have.`,
    );
  });

  test("a nested SQL-error failure un-aborts via ROLLBACK TO SAVEPOINT and leaves the outer transaction usable", async () => {
    // The JavaScript-throw arm above can never reach SQLSTATE 25P02: a body
    // that throws in JS leaves no aborted transaction to un-abort. Only a SQL
    // error (here a duplicate-key insert, 23505) puts the outer transaction in
    // the aborted state, and only `ROLLBACK TO SAVEPOINT` un-aborts it — the
    // exact property `persistChatTurnRunInTx` depends on when it recovers from
    // a unique violation inside the chat-turn transaction.
    const seen: {
      outerTxid?: string;
      innerTxid?: string;
      innerRejection?: string;
      rowsAfterFailure?: number | string;
      callerWriteAccepted?: boolean;
    } = {};

    await assert.rejects(
      db().transaction(async (outer) => {
        await outer.execute(
          sql`create temp table run_atomic_probe (id int primary key) on commit drop`,
        );
        seen.outerTxid = await currentTxid(outer);

        try {
          await runAtomic(outer, async (inner) => {
            await inner.execute(sql`insert into run_atomic_probe (id) values (1)`);
            seen.innerTxid = await currentTxid(inner);
            // Same primary key a second time — a SQL error, not a JS throw.
            await inner.execute(sql`insert into run_atomic_probe (id) values (1)`);
          });
        } catch (err) {
          seen.innerRejection = err instanceof Error ? err.name : String(err);
        }

        // Un-aborted: the read answers instead of raising 25P02, and it sees
        // none of the failed body's writes.
        try {
          const result = await outer.execute(sql`select count(*)::int as n from run_atomic_probe`);
          const [row] = rowsFromExecute<{ n: number }>(result);
          seen.rowsAfterFailure = row?.n ?? -1;
        } catch (err) {
          seen.rowsAfterFailure = sqlState(err) ?? `non-sqlstate: ${String(err)}`;
        }

        // The caller's own write must still be accepted — a transaction left
        // aborted by the SQL error would refuse it with 25P02.
        try {
          await outer.execute(sql`insert into run_atomic_probe (id) values (2)`);
          seen.callerWriteAccepted = true;
        } catch (err) {
          seen.callerWriteAccepted = false;
        }

        throw new RollbackSentinel();
      }),
      RollbackSentinel,
    );

    assert.ok(seen.innerRejection, "the inner SQL error must reject");
    assert.ok(seen.outerTxid, "the outer transaction reported no txid");
    assert.equal(
      seen.innerTxid,
      seen.outerTxid,
      "nesting opened a SECOND transaction — the outermost transaction is no longer the single commit unit",
    );
    assert.equal(
      seen.rowsAfterFailure,
      0,
      `the outer read must answer 0 after the nested SQL error; got ${String(seen.rowsAfterFailure)}. A SQLSTATE here means the rollback-to-savepoint never un-aborted the transaction.`,
    );
    assert.equal(
      seen.callerWriteAccepted,
      true,
      "the outer transaction must still accept the caller's own write after the nested SQL error",
    );
  });

  test("the root client gets one fresh transaction per call, spanning the whole body", async () => {
    // Two statements per call, because ONE statement cannot tell a transaction
    // from autocommit: every bare statement on the root client already runs in
    // an implicit transaction of its own and reports a txid. Only a SHARED txid
    // across two statements proves the body ran inside one transaction, which
    // is what dies if `runAtomic` ever hands the root client through unwrapped.
    const first = await runAtomic(db(), async (tx) => [
      await currentTxid(tx),
      await currentTxid(tx),
    ]);
    const second = await runAtomic(db(), (tx) => currentTxid(tx));

    assert.equal(
      first[0],
      first[1],
      "two statements in one root-client body reported different transactions — the body did not run inside a transaction at all",
    );
    assert.notEqual(
      first[0],
      second,
      "two separate calls shared one transaction — each root-client call must open its own",
    );
  });

  test("depth-2 nesting still keeps the outermost transaction the single commit unit", async () => {
    // The headline claim is "any depth": `txid_current()` is constant through
    // ANY depth of nesting, and the invariant says "any sequence of nested
    // `runAtomic` calls". The other two arms drive depth 1 only; a future
    // drizzle upgrade that changed savepoint naming or nesting behavior at
    // depth >= 2 (a name that collides across siblings, or a nested commit)
    // would go green today without this arm.
    const seen: {
      outerTxid?: string;
      depth1Txid?: string;
      depth2Txid?: string;
      innerRejection?: string;
      rowsAfterFailure?: number | string;
    } = {};

    await assert.rejects(
      db().transaction(async (outer) => {
        await outer.execute(
          sql`create temp table run_atomic_probe (id int primary key) on commit drop`,
        );
        seen.outerTxid = await currentTxid(outer);

        await runAtomic(outer, async (depth1) => {
          seen.depth1Txid = await currentTxid(depth1);

          try {
            await runAtomic(depth1, async (depth2) => {
              seen.depth2Txid = await currentTxid(depth2);
              await depth2.execute(sql`insert into run_atomic_probe (id) values (1)`);
              throw new InnerFailure();
            });
          } catch (err) {
            seen.innerRejection = err instanceof Error ? err.name : String(err);
          }
        });

        // The depth-2 failure rolled back to its savepoint; the outer read
        // still answers 0 and the outer transaction is still usable.
        try {
          const result = await outer.execute(sql`select count(*)::int as n from run_atomic_probe`);
          const [row] = rowsFromExecute<{ n: number }>(result);
          seen.rowsAfterFailure = row?.n ?? -1;
        } catch (err) {
          seen.rowsAfterFailure = sqlState(err) ?? `non-sqlstate: ${String(err)}`;
        }

        throw new RollbackSentinel();
      }),
      RollbackSentinel,
    );

    assert.ok(seen.outerTxid, "the outer transaction reported no txid");
    assert.equal(
      seen.depth1Txid,
      seen.outerTxid,
      "depth-1 nesting opened a SECOND transaction — the outermost transaction is no longer the single commit unit",
    );
    assert.equal(
      seen.depth2Txid,
      seen.outerTxid,
      "depth-2 nesting opened a SECOND transaction — the outermost transaction is no longer the single commit unit",
    );
    assert.equal(
      seen.innerRejection,
      "InnerFailure",
      "the depth-2 rejection must propagate unchanged",
    );
    assert.equal(
      seen.rowsAfterFailure,
      0,
      `the outer read must answer 0 after the depth-2 failure; got ${String(seen.rowsAfterFailure)}`,
    );
  });

  test("a second concurrent runAtomic on one handle is refused before any SQL runs", async () => {
    // The runtime guard (campaign item 274): the round-2 measurement showed two
    // concurrent `runAtomic` calls on ONE handle silently lose writes — drizzle
    // names every savepoint after depth alone (`sp${nestedIndex + 1}`), so the
    // two bodies share a name and one's `ROLLBACK TO SAVEPOINT` discards the
    // other's live writes while both are in flight. The guard refuses the second
    // call before it can send any statement, so the outer transaction stays
    // usable and keeps both surviving writes.
    const seen: {
      outerTxid?: string;
      /** The guard's message when the second call is refused, or null if it ran. */
      secondRefused?: string | null;
      firstResolved?: boolean;
      rowsAfterSecond?: number | string;
    } = {};

    await assert.rejects(
      db().transaction(async (outer) => {
        await outer.execute(
          sql`create temp table run_atomic_probe (id int primary key) on commit drop`,
        );
        seen.outerTxid = await currentTxid(outer);

        let releaseFirst: (() => void) | undefined;
        const firstStarted = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });

        const first = runAtomic(outer, async (inner) => {
          await inner.execute(sql`insert into run_atomic_probe (id) values (1)`);
          await firstStarted;
        });

        try {
          await runAtomic(outer, async () => {});
          seen.secondRefused = null;
        } catch (err) {
          seen.secondRefused = err instanceof Error ? err.message : String(err);
        }

        releaseFirst?.();
        await first;
        seen.firstResolved = true;

        try {
          await outer.execute(sql`insert into run_atomic_probe (id) values (2)`);
          const result = await outer.execute(sql`select count(*)::int as n from run_atomic_probe`);
          const [row] = rowsFromExecute<{ n: number }>(result);
          seen.rowsAfterSecond = row?.n ?? -1;
        } catch (err) {
          seen.rowsAfterSecond = sqlState(err) ?? `non-sqlstate: ${String(err)}`;
        }

        throw new RollbackSentinel();
      }),
      RollbackSentinel,
    );

    assert.ok(seen.secondRefused, "the second concurrent runAtomic was not refused");
    assert.match(
      seen.secondRefused ?? "",
      /already has a nested body in flight/,
      "the refusal must name the precondition so the caller knows the fix",
    );
    assert.ok(seen.outerTxid, "the outer transaction reported no txid");
    assert.equal(
      seen.firstResolved,
      true,
      "the refused second call must not disturb the in-flight first body",
    );
    assert.equal(
      seen.rowsAfterSecond,
      2,
      `the outer transaction must stay usable and keep both surviving writes; got ${String(seen.rowsAfterSecond)}`,
    );
  });
});
