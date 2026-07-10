import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  _resetRegistryForTests,
  getWorkflow,
  listPublicWorkflows,
  registerWorkflow,
} from "../../src/modules/agent/registry";
import type { Workflow } from "../../src/modules/agent/types";
import { getBuiltinWorkflowSeedPlan } from "../../src/modules/workflows/seeder";

function workflow(slug: string, options: { resumeOnly?: boolean } = {}): Workflow<unknown> {
  return {
    slug,
    name: slug,
    resumeOnly: options.resumeOnly,
    trigger: { kind: "manual" },
    initialState: () => ({}),
    initialStep: "done",
    steps: {
      done: {
        id: "done",
        run: async () => ({ kind: "done", state: {} }),
      },
    },
  };
}

describe("built-in workflow catalog and seed filtering", () => {
  beforeEach(() => {
    _resetRegistryForTests();
  });

  afterEach(() => {
    _resetRegistryForTests();
  });

  test("resume-only workflows stay registered but are absent from the public catalog", () => {
    registerWorkflow(workflow("daily-briefing"));
    registerWorkflow(workflow("morning-briefing", { resumeOnly: true }));
    registerWorkflow(workflow("__internal"));

    assert.equal(getWorkflow("morning-briefing")?.resumeOnly, true);
    assert.deepEqual(
      listPublicWorkflows().map((item) => item.slug),
      ["daily-briefing"],
    );
  });

  test("the seeder plans active definitions and retires resume-only rows", () => {
    registerWorkflow(workflow("daily-briefing"));
    registerWorkflow(workflow("morning-briefing", { resumeOnly: true }));

    const plan = getBuiltinWorkflowSeedPlan();

    assert.deepEqual(
      plan.seed.map((item) => item.slug),
      ["daily-briefing"],
    );
    assert.deepEqual(plan.retireSlugs, ["morning-briefing"]);
  });
});
