import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { closeConnections, db, rowsFromExecute } from "@alfred/db";
import { runAtomic, type DbRunner } from "@alfred/db/helpers";
import { pgErrorChain } from "@alfred/db/pg-errors";
import { sql } from "drizzle-orm";

import { dbBackedSkip } from "./support/db-backed";

/**
 * Pins that a nested `runAtomic` opens a savepoint, not a reuse of the caller's transaction.
 * The key check is `rowsAfterFailure`: a savepoint reads `0`. Reuse would read `1`
 * after a JS throw, or raise `25P02` after a SQL error.
 * Needs a migrated Postgres (`docker compose up postgres`); CI fails instead of skipping.
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

/** The current transaction id. Same value inside one transaction; a bigint, so a string. */
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
    // Assert outside the transaction; a throw inside would hide which check failed.
    interface Seen {
      outerTxid?: string;
      innerTxid?: string;
      innerRejection?: string;
      /** The row count after the inner failure, or the SQLSTATE the read raised. */
      rowsAfterFailure?: number | string;
    }

    const seen: Seen = {};

    await assert.rejects(
      db().transaction(async (outer) => {
        // A temp table is per session; this works because one transaction uses one pooled client.
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

        // Savepoint: `0`. Reuse: a non-zero count, or `25P02` after a SQL error.
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
    // Only a SQL error aborts the outer transaction, and only `ROLLBACK TO SAVEPOINT`
    // recovers it. `persistChatTurnRunInTx` relies on this after a unique violation.
    interface Seen {
      outerTxid?: string;
      innerTxid?: string;
      innerRejection?: string;
      rowsAfterFailure?: number | string;
      callerWriteAccepted?: boolean;
    }

    const seen: Seen = {};

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
            await inner.execute(sql`insert into run_atomic_probe (id) values (1)`);
          });
        } catch (err) {
          seen.innerRejection = err instanceof Error ? err.name : String(err);
        }

        try {
          const result = await outer.execute(sql`select count(*)::int as n from run_atomic_probe`);
          const [row] = rowsFromExecute<{ n: number }>(result);
          seen.rowsAfterFailure = row?.n ?? -1;
        } catch (err) {
          seen.rowsAfterFailure = sqlState(err) ?? `non-sqlstate: ${String(err)}`;
        }

        try {
          await outer.execute(sql`insert into run_atomic_probe (id) values (2)`);
          seen.callerWriteAccepted = true;
        } catch {
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
    // One statement cannot tell a transaction from autocommit. Two that share a txid can.
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
    // The other tests nest one level only. This catches a drizzle change at depth 2.
    interface Seen {
      outerTxid?: string;
      depth1Txid?: string;
      depth2Txid?: string;
      innerRejection?: string;
      rowsAfterFailure?: number | string;
    }

    const seen: Seen = {};

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
    // Drizzle names savepoints by depth only (`sp${nestedIndex + 1}`). Two concurrent
    // bodies on one handle share a name, and one rollback drops the other's writes.
    interface Seen {
      outerTxid?: string;
      /** The guard's message when the second call is refused, or null if it ran. */
      secondRefused?: string | null;
      firstResolved?: boolean;
      rowsAfterSecond?: number | string;
    }

    const seen: Seen = {};

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
