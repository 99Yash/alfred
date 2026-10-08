/**
 * Fail when a schema CHECK constraint differs from the newest migration snapshot.
 * A schema edit after `db:generate` leaves the migration without the new CHECK,
 * and inserts of the new value then fail in production. Fix: run `db:generate` again.
 * Zero checks on either side also fails, because then the gate checks nothing.
 *
 * Usage: pnpm --filter @alfred/db check:constraint-snapshot
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import * as schema from "../schemas";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const MIGRATIONS_META = join(PACKAGE_ROOT, "src/migrations/meta");

/** `<table>.<constraint>` -> rendered expression. */
type CheckExpressions = ReadonlyMap<string, string>;

interface NewestSnapshot {
  tag: string;
  checks: CheckExpressions;
}

const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number().int().nonnegative(), tag: z.string() })).min(1),
});

const snapshotSchema = z.object({
  tables: z.record(
    z.string(),
    z.object({
      name: z.string(),
      checkConstraints: z.record(z.string(), z.object({ name: z.string(), value: z.string() })),
    }),
  ),
});

function schemaChecks(): CheckExpressions {
  const dialect = new PgDialect();
  const out = new Map<string, string>();

  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const table = getTableConfig(value);

    for (const check of table.checks) {
      out.set(`${table.name}.${check.name}`, dialect.sqlToQuery(check.value).sql);
    }
  }

  return out;
}

function newestSnapshotChecks(): NewestSnapshot {
  const journal = journalSchema.parse(
    JSON.parse(readFileSync(join(MIGRATIONS_META, "_journal.json"), "utf8")),
  );

  const last = journal.entries[journal.entries.length - 1]!;
  const file = `${String(last.idx).padStart(4, "0")}_snapshot.json`;

  const snapshot = snapshotSchema.parse(
    JSON.parse(readFileSync(join(MIGRATIONS_META, file), "utf8")),
  );

  const out = new Map<string, string>();

  for (const table of Object.values(snapshot.tables)) {
    for (const check of Object.values(table.checkConstraints)) {
      out.set(`${table.name}.${check.name}`, check.value);
    }
  }

  return { tag: last.tag, checks: out };
}

function constraintDrift(fromSchema: CheckExpressions, fromSnapshot: CheckExpressions): string[] {
  const violations: string[] = [];

  for (const [key, expression] of fromSchema) {
    const recorded = fromSnapshot.get(key);

    if (recorded === undefined) {
      violations.push(`${key}: in the schema but not in the newest snapshot (run db:generate).`);
    } else if (recorded !== expression) {
      violations.push(
        `${key}: expression changed.\n    schema:   ${expression}\n    snapshot: ${recorded}\n` +
          `    The schema moved after the last db:generate. Run db:generate again, or add "ALTER TABLE ... DROP CONSTRAINT" + "ADD CONSTRAINT" to the newest migration and set the snapshot value to the schema text.`,
      );
    }
  }

  for (const key of fromSnapshot.keys()) {
    if (!fromSchema.has(key)) {
      violations.push(`${key}: in the newest snapshot but not in the schema (run db:generate).`);
    }
  }

  return violations;
}

function selfTestFailures(): string[] {
  const failures: string[] = [];
  const base = new Map([["t.c_valid", `"t"."c" IN ('a', 'b')`]]);
  const drifted = new Map([["t.c_valid", `"t"."c" IN ('a', 'b', 'c')`]]);

  if (constraintDrift(drifted, base).length !== 1)
    failures.push("a changed expression did not report");

  if (constraintDrift(base, base).length !== 0) failures.push("an equal expression reported");

  if (constraintDrift(new Map(), base).length !== 1)
    failures.push("a snapshot-only check did not report");

  return failures;
}

const selfTest = selfTestFailures();

if (selfTest.length > 0) {
  console.error("check-constraint-snapshot self-test failed:");

  for (const failure of selfTest) console.error(`  ${failure}`);
  process.exit(1);
}

const fromSchema = schemaChecks();

const { tag, checks: fromSnapshot } = newestSnapshotChecks();

if (fromSchema.size === 0 || fromSnapshot.size === 0) {
  console.error(
    `check-constraint-snapshot: discovered ${fromSchema.size} schema check(s) and ${fromSnapshot.size} snapshot check(s); a side with none means the input moved, not that nothing drifted.`,
  );
  process.exit(1);
}

const violations = constraintDrift(fromSchema, fromSnapshot);

if (violations.length > 0) {
  console.error(`CHECK constraints disagree with snapshot ${tag}:\n`);

  for (const violation of violations) console.error(`  ${violation}\n`);
  process.exit(1);
}

console.log(
  `check-constraint-snapshot: ${fromSchema.size} CHECK constraint(s) match snapshot ${tag}.`,
);
