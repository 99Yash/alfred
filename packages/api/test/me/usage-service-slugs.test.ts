import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { COLD_START_WORKFLOW_SLUG } from "../../src/modules/cold-start/workflow-input";
import { SUB_AGENT_WORKFLOW_SLUG } from "../../src/modules/agent/sub-agent-metadata";
import {
  DAILY_BRIEFING_WORKFLOW_SLUG,
  LEGACY_MORNING_BRIEFING_WORKFLOW_SLUG,
} from "../../src/modules/briefing/workflow-input";
import { LEARN_SKILL_WORKFLOW_SLUG } from "../../src/modules/skills/workflow-input";
import { SKILL_DOCUMENTATION_WORKFLOW_SLUG } from "../../src/modules/skill-documentation/workflow-input";
import { TRIAGE_WORKFLOW_SLUG } from "../../src/modules/triage/workflow-input";
import { SLUG_CATEGORY } from "../../src/modules/me/usage-service";

/**
 * `SLUG_CATEGORY` (usage-service) hard-codes workflow slugs as literals rather
 * than importing the workflow modules that define them (those pull heavy
 * graphs). That decouples the read service, but it means a slug rename in a
 * workflow module leaves this map silently stale — misattributing that run's
 * cost. These tests are the drift guard: they re-couple the two at test time.
 */
describe("SLUG_CATEGORY drift guard", () => {
  // Each importable slug constant must still be a recognized key. If someone
  // renames a workflow slug, the constant changes and this assertion fails
  // instead of the run's cost quietly landing in the wrong (or no) bucket.
  const CONSTANT_SLUGS: Array<[string, string]> = [
    ["triage", TRIAGE_WORKFLOW_SLUG],
    ["cold_start", COLD_START_WORKFLOW_SLUG],
    ["briefing (daily)", DAILY_BRIEFING_WORKFLOW_SLUG],
    ["briefing (legacy morning)", LEGACY_MORNING_BRIEFING_WORKFLOW_SLUG],
    ["skill (learn)", LEARN_SKILL_WORKFLOW_SLUG],
    ["skill (documentation)", SKILL_DOCUMENTATION_WORKFLOW_SLUG],
    ["sub_agent", SUB_AGENT_WORKFLOW_SLUG],
  ];
  for (const [name, slug] of CONSTANT_SLUGS) {
    test(`recognizes the live ${name} slug (${slug})`, () => {
      assert.ok(
        Object.hasOwn(SLUG_CATEGORY, slug),
        `SLUG_CATEGORY is missing "${slug}" — a workflow slug was renamed without updating the usage map`,
      );
    });
  }

  // Pin the full key set so adding/removing/renaming any entry (including the
  // three slugs defined as raw literals — `__chat-turn__`,
  // `__chat-memory-capture__`, `memory-extraction` — that have no importable
  // constant to check above) is a conscious, test-updating change.
  test("map key set is unchanged", () => {
    assert.deepEqual(Object.keys(SLUG_CATEGORY).sort(), [
      "__chat-memory-capture__",
      "__chat-turn__",
      "__user-authored-brief__",
      "cold-start-research",
      "daily-briefing",
      "email-triage",
      "learn-skill",
      "memory-extraction",
      "morning-briefing",
      "skill-documentation",
    ]);
  });
});
