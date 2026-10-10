import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { WorkflowTrigger } from "@alfred/contracts";

import { dailyBriefingWorkflow, morningBriefingWorkflow } from "@alfred/assistant/briefings";
import { chatMemoryCaptureWorkflow } from "@alfred/assistant/chat";
import {
  buildMemoryExtractionWorkflow,
  coldStartResearchWorkflow,
} from "@alfred/assistant/knowledge";
import { learnSkillWorkflow, skillDocumentationWorkflow } from "@alfred/assistant/skills";
import { emailTriageWorkflow, gmailSenderAdapter } from "@alfred/assistant/triage";

// The injected sender adapter (ADR-0089) does not affect recipe identity.
const memoryExtractionWorkflow = buildMemoryExtractionWorkflow(gmailSenderAdapter);

import type { Workflow, WorkflowInput } from "@alfred/assistant/execution";

/**
 * Pin each recipe's slug, steps, entry, `trigger`, and `dedupKey` at its owning subpath.
 * A change breaks resume of a persisted run, fires it from another event,
 * or drops the `agent_runs_dedup_key_idx` singleton guard (ADR-0027, ADR-0047).
 */
describe("moved product recipes keep their identity at their owning module seam", () => {
  // `dedupKey` ignores the trigger, but `WorkflowInput` requires one.
  const sampleTrigger: WorkflowInput["trigger"] = { kind: "manual" };

  const cases: ReadonlyArray<{
    name: string;
    recipe: Workflow<unknown>;
    slug: string;
    initialStep: string;
    steps: readonly string[];
    resumeOnly?: boolean;
    trigger: WorkflowTrigger;
    /** `null` means no `dedupKey`. Inputs must parse: some recipes `schema.parse` them. */
    dedup: null | ReadonlyArray<{ input: WorkflowInput; expected: string | null }>;
  }> = [
    // `slug` is the persisted literal, not the recipe's constant, so a renamed constant goes red.
    {
      name: "dailyBriefingWorkflow",
      recipe: dailyBriefingWorkflow as Workflow<unknown>,
      slug: "daily-briefing",
      initialStep: "gather",
      steps: ["gather", "compose", "send"],
      trigger: { kind: "cron", schedule: "0 * * * *" },
      dedup: null,
    },
    {
      name: "morningBriefingWorkflow (legacy, resume-only)",
      recipe: morningBriefingWorkflow as Workflow<unknown>,
      slug: "morning-briefing",
      initialStep: "gather",
      steps: ["gather", "compose", "send"],
      resumeOnly: true,
      trigger: { kind: "cron", schedule: "0 * * * *" },
      dedup: null,
    },
    {
      name: "emailTriageWorkflow",
      recipe: emailTriageWorkflow as Workflow<unknown>,
      slug: "email-triage",
      initialStep: "classify",
      steps: ["classify", "apply-label", "open-document-ask", "close-loop-todos"],
      trigger: { kind: "event", source: "gmail", type: "message_received" },
      dedup: null,
    },
    {
      name: "memoryExtractionWorkflow",
      recipe: memoryExtractionWorkflow as Workflow<unknown>,
      slug: "memory-extraction",
      initialStep: "pick-documents",
      steps: ["pick-documents", "process", "finalize"],
      trigger: { kind: "cron", schedule: "0 3 * * *" },
      dedup: null,
    },
    {
      name: "chatMemoryCaptureWorkflow",
      recipe: chatMemoryCaptureWorkflow as Workflow<unknown>,
      slug: "__chat-memory-capture__",
      initialStep: "load-transcript",
      steps: ["load-transcript", "extract", "finalize"],
      trigger: { kind: "manual" },
      // Keyed off `metadata`. A run without thread and message has no guard.
      dedup: [
        {
          input: {
            userId: "u1",
            trigger: sampleTrigger,
            metadata: { threadId: "t1", captureAfterMessageId: "m1" },
          },
          expected: "chat-memory:t1:m1",
        },
        { input: { userId: "u1", trigger: sampleTrigger }, expected: null },
      ],
    },
    {
      name: "skillDocumentationWorkflow",
      recipe: skillDocumentationWorkflow as Workflow<unknown>,
      slug: "skill-documentation",
      initialStep: "gather-context",
      steps: ["gather-context", "compose", "persist-revision", "notify"],
      trigger: { kind: "event", source: "learn-skill", type: "completed" },
      // Per-skill singleton; `schema.parse` requires `skillId`.
      dedup: [
        {
          input: { userId: "u1", trigger: sampleTrigger, input: { skillId: "skill_1" } },
          expected: "skill-doc:skill_1",
        },
      ],
    },
    {
      name: "learnSkillWorkflow",
      recipe: learnSkillWorkflow as Workflow<unknown>,
      slug: "learn-skill",
      initialStep: "gather",
      steps: ["gather", "distill", "persist"],
      trigger: { kind: "manual" },
      // Per-skill singleton; `schema.parse` requires both `skillId` and `prompt`.
      dedup: [
        {
          input: {
            userId: "u1",
            trigger: sampleTrigger,
            input: { skillId: "skill_1", prompt: "p" },
          },
          expected: "learn-skill:skill_1",
        },
      ],
    },
    {
      name: "coldStartResearchWorkflow",
      recipe: coldStartResearchWorkflow as Workflow<unknown>,
      slug: "cold-start-research",
      initialStep: "gather-signals",
      steps: [
        "gather-signals",
        "seed",
        "research-aspects",
        "synthesis",
        "extract-facts",
        "persist",
      ],
      trigger: { kind: "event", source: "google.oauth.callback", type: "completed" },
      // One run per user: a constant key.
      dedup: [{ input: { userId: "u1", trigger: sampleTrigger }, expected: "cold-start" }],
    },
  ];

  for (const c of cases) {
    test(`${c.name} is reachable from its owning @alfred/assistant module with a stable identity`, () => {
      assert.ok(c.recipe, `${c.name} must be exported by the module that owns it`);
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

      assert.deepEqual(c.recipe.trigger, c.trigger, "trigger declaration must be unchanged");

      if (c.dedup === null) {
        assert.equal(
          typeof c.recipe.dedupKey,
          "undefined",
          "recipe must declare no singleton dedup key",
        );
      } else {
        assert.equal(
          typeof c.recipe.dedupKey,
          "function",
          "recipe must declare a singleton dedup key",
        );

        for (const s of c.dedup) {
          assert.equal(
            c.recipe.dedupKey!(s.input),
            s.expected,
            "dedup-key derivation must be unchanged",
          );
        }
      }
    });
  }
});
