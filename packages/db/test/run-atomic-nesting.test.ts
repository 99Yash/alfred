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
});
