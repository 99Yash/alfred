import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  chatMemoryCaptureWorkflow,
  dailyBriefingWorkflow,
  emailTriageWorkflow,
  memoryExtractionWorkflow,
  morningBriefingWorkflow,
  skillDocumentationWorkflow,
} from "../../src/backend";
import type { Workflow } from "../../src/modules/agent/types";

/**
 * Item 04 moves the product recipe declarations out of
 * `apps/server/src/builtins/workflows/` into the module that owns each domain,
 * then re-exports them through `@alfred/api/backend` (the seam the composition
 * root registers from). The move is behavior-neutral: the recipe identity — its
 * slug, its ordered step ids, its entry step — must stay byte-identical, or a
 * persisted nonterminal run resolves to a different state machine on resume.
 *
 * This pins that identity at the public seam. It does not exercise the step
 * bodies (those did not move); item 06's generic-execution contract test guards
 * the registration list.
 */
describe("moved product recipes keep their identity at the backend seam", () => {
  const cases: ReadonlyArray<{
    name: string;
    recipe: Workflow<unknown>;
    slug: string;
    initialStep: string;
    steps: readonly string[];
    resumeOnly?: boolean;
  }> = [
    // `slug` here is the LITERAL persisted wire string, not the recipe's own
    // slug constant. A resuming run keys on this exact string; asserting it
    // against the same constant the recipe imports would only prove the import
    // wired up, not that the durable contract is stable.
    {
      name: "dailyBriefingWorkflow",
      recipe: dailyBriefingWorkflow as Workflow<unknown>,
      slug: "daily-briefing",
      initialStep: "gather",
      steps: ["gather", "compose", "send"],
    },
    {
      name: "morningBriefingWorkflow (legacy, resume-only)",
      recipe: morningBriefingWorkflow as Workflow<unknown>,
      slug: "morning-briefing",
      initialStep: "gather",
      steps: ["gather", "compose", "send"],
      resumeOnly: true,
    },
    {
      name: "emailTriageWorkflow",
      recipe: emailTriageWorkflow as Workflow<unknown>,
      slug: "email-triage",
      initialStep: "classify",
      steps: ["classify", "apply-label"],
    },
    {
      name: "memoryExtractionWorkflow",
      recipe: memoryExtractionWorkflow as Workflow<unknown>,
      slug: "memory-extraction",
      initialStep: "pick-documents",
      steps: ["pick-documents", "process", "finalize"],
    },
    {
      name: "chatMemoryCaptureWorkflow",
      recipe: chatMemoryCaptureWorkflow as Workflow<unknown>,
      slug: "__chat-memory-capture__",
      initialStep: "load-transcript",
      steps: ["load-transcript", "extract", "finalize"],
    },
    {
      name: "skillDocumentationWorkflow",
      recipe: skillDocumentationWorkflow as Workflow<unknown>,
      slug: "skill-documentation",
      initialStep: "gather-context",
      steps: ["gather-context", "compose", "persist-revision", "notify"],
    },
  ];

  for (const c of cases) {
    test(`${c.name} is reachable through @alfred/api/backend with a stable identity`, () => {
      assert.ok(c.recipe, `${c.name} must be re-exported by backend`);
      assert.equal(c.recipe.slug, c.slug, "slug must match the module's own slug constant");
      assert.equal(c.recipe.initialStep, c.initialStep, "entry step must be unchanged");
      assert.deepEqual(
        Object.keys(c.recipe.steps),
        c.steps,
        "the ordered step ids must be unchanged",
      );
      if (c.resumeOnly !== undefined) {
        assert.equal(c.recipe.resumeOnly, c.resumeOnly, "resume-only flag must be unchanged");
      }
    });
  }
});
