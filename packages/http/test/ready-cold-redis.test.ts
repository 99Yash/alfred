import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { getStringPath } from "@alfred/contracts";
import { closeRedis } from "@alfred/db/redis";

import { dbBackedSkip } from "./support/db-backed";
import { applyServerEnvFixtures } from "./support/server-env";

/**
 * `/ready` against a real Redis, on the process's first request (regression: #127).
 * A fail-fast connection pinged in the tick it was built rejects, so `/ready` always gave 503.
 * `root-app.test.ts` mocks `ping` and cannot see this, so this file mocks nothing.
 * Exactly one request: a second finds a ready connection and passes either way.
 * Asserts only `checks.redis`; the `db` check needs a migrated database.
 */

// The plain fixture form plants no service URL, so the guard still skips without services.
const skip = dbBackedSkip("database+redis");

applyServerEnvFixtures();

const { app } = await import("@alfred/http");

after(async () => {
  await closeRedis();
});

describe("/ready on a cold process", { skip }, () => {
  test("reports Redis healthy on the first request, with no ioredis mock", async () => {
    const response = await app.handle(new Request("http://localhost/ready"));
    const body: unknown = await response.json();

    assert.equal(
      getStringPath(body, "checks", "redis"),
      "ok",
      'the first /ready request of a process must reach Redis — "error" here means the probe connection rejects its own cold window',
    );
  });
});
