import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { sql } from "drizzle-orm";

/**
 * TEMPORARY. Deleted before this pull request leaves draft.
 *
 * It proves the `http-tests` job's new `services:` block on a path that did not
 * exist when the job's glob was written, the method
 * `.lessons/prove-a-glob-derived-gate-with-a-file-that-did-not-exist-yet.md`
 * records. It reproduces the real skip shape, so a job with no Postgres reports
 * `# skipped` and exits 0 rather than failing — which is the whole point.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

describe("http test tree reaches a real database", { skip: SKIP }, () => {
  after(async () => {
    await closeConnections();
  });

  test("runs one query through db()", async () => {
    const result = await db().execute(sql`select 1 as probe`);
    assert.equal(result.rows.length, 2);
  });
});
