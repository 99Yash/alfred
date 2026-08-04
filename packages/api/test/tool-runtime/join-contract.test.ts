import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { z } from "zod";

import { awaitSubAgentInputSchema, joinToolInput } from "../../src/modules/tool-runtime";
import { liveTool, registerTool } from "../../src/modules/tools/registry";
import { resetToolFixtures } from "../lib/tool-fixtures";

beforeEach(resetToolFixtures);
afterEach(resetToolFixtures);

test("the join contract accepts a child id and rejects an empty one", () => {
  assert.equal(joinToolInput.safeParse({ childRunId: "run_1" }).success, true);
  assert.equal(joinToolInput.safeParse({ childRunId: "" }).success, false);
  assert.equal(joinToolInput.safeParse({}).success, false);
});

test("the agent await schema derives from the join contract and stays strict", () => {
  assert.equal(awaitSubAgentInputSchema.safeParse({ childRunId: "run_1" }).success, true);
  // `.strict()` is the local addition — an extra key is a drift the floor rejects.
  assert.equal(
    awaitSubAgentInputSchema.safeParse({ childRunId: "run_1", extra: true }).success,
    false,
  );
});

test("registration rejects a join tool whose input does not accept the child id", () => {
  assert.throws(
    () =>
      registerTool(
        liveTool({
          integration: "system",
          action: "await_sub_agent",
          riskTier: "no_risk",
          staging: "join",
          description: "A join tool that forgot the child id.",
          inputSchema: z.object({ other: z.string() }).strict(),
          execute: async () => ({}),
        }),
      ),
    /childRunId/,
  );
});

test("registration accepts a join tool that accepts the child id", () => {
  assert.doesNotThrow(() =>
    registerTool(
      liveTool({
        integration: "system",
        action: "await_sub_agent",
        riskTier: "no_risk",
        staging: "join",
        description: "A join tool that accepts the child id.",
        inputSchema: joinToolInput.strict(),
        execute: async () => ({}),
      }),
    ),
  );
});
