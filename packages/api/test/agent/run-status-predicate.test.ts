import assert from "node:assert/strict";
import { test } from "node:test";

import { agentRuns, runIsNotTerminal } from "@alfred/db/schemas";
import { PgDialect } from "drizzle-orm/pg-core";

test("the partial-index non-terminal predicate changes only deliberately", () => {
  const rendered = new PgDialect().sqlToQuery(runIsNotTerminal(agentRuns.status)).sql;
  assert.equal(rendered, `"agent_runs"."status" NOT IN ('completed', 'failed', 'cancelled')`);
});
