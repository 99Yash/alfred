import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { COLD_START_WORKFLOW_SLUG } from "@alfred/assistant/knowledge/cold-start/workflow-input";
import { SUB_AGENT_WORKFLOW_SLUG } from "@alfred/assistant/execution/sub-agent-metadata";
import {
  DAILY_BRIEFING_WORKFLOW_SLUG,
  LEGACY_MORNING_BRIEFING_WORKFLOW_SLUG,
} from "@alfred/assistant/briefings/workflow-input";
import { LEARN_SKILL_WORKFLOW_SLUG } from "@alfred/assistant/skills/workflow-input";
import { SKILL_DOCUMENTATION_WORKFLOW_SLUG } from "@alfred/assistant/skills/skill-documentation-workflow-input";
import { TRIAGE_WORKFLOW_SLUG } from "@alfred/assistant/triage/workflow-input";
import { SLUG_CATEGORY } from "@alfred/assistant/execution/usage-report";

/** `SLUG_CATEGORY` hard-codes slugs to avoid heavy imports; this catches a rename that would misfile cost. */
describe("SLUG_CATEGORY drift guard", () => {
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

  // Pin the full key set, which covers slugs with no importable constant.
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
      "reply-drafting",
      "skill-documentation",
    ]);
  });
});
