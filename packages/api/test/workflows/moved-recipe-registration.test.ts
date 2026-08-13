import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { WorkflowTrigger } from "@alfred/contracts";

import { dailyBriefingWorkflow, morningBriefingWorkflow } from "@alfred/assistant/briefings";
import { chatMemoryCaptureWorkflow } from "@alfred/assistant/conversations";
import {
  buildMemoryExtractionWorkflow,
  coldStartResearchWorkflow,
} from "@alfred/assistant/knowledge";
import { learnSkillWorkflow, skillDocumentationWorkflow } from "@alfred/assistant/skills";
import { emailTriageWorkflow, gmailSenderAdapter } from "@alfred/assistant/triage";

// The recipe is built with the injected Gmail sender adapter (ADR-0089); its
// identity (slug/steps/entry/trigger/dedup) is independent of the injection.
const memoryExtractionWorkflow = buildMemoryExtractionWorkflow(gmailSenderAdapter);
import type { Workflow, WorkflowInput } from "@alfred/assistant/execution/types";

/**
 * Item 04 moves the product recipe declarations out of
 * `apps/server/src/builtins/workflows/` into the module that owns each domain.
 * Each recipe is published by that module's own `@alfred/assistant` subpath,
 * which is the seam the composition root registers from. (The
 * `@alfred/api/backend` door that once forwarded them is deleted; see
 * `packages/api/test/no-transitional-doors.test.ts`.) The move is
 * behavior-neutral: the recipe identity — its
 * slug, its ordered step ids, its entry step, its `trigger` declaration, and its
 * `dedupKey` derivation — must stay byte-identical, or a persisted nonterminal
 * run resolves to a different state machine on resume, fires from a different
 * event, or loses its singleton guard.
 *
 * The `trigger` is the fire path the cron dispatcher / event matcher reads
 * (ADR-0027/ADR-0047); `dedupKey` is the value the `agent_runs_dedup_key_idx`
 * partial-unique-index (23505) singleton guard keys on. Both are durable
 * obligations a later in-module refactor could silently break, so both are
 * pinned here alongside slug/entry/steps.
 *
 * This pins that identity at the public seam. It does not exercise the step
 * bodies (those did not move); item 06's generic-execution contract test guards
 * the registration list.
 */
describe("moved product recipes keep their identity at their owning module seam", () => {
  // A schema-valid manual trigger for the dedupKey samples. Every `dedupKey`
  // below ignores `userId`/`trigger` (they read only `input`/`metadata`), but
  // `WorkflowInput` requires them, so this satisfies the shape.
  const sampleTrigger: WorkflowInput["trigger"] = { kind: "manual" };

  const cases: ReadonlyArray<{
    name: string;
    recipe: Workflow<unknown>;
    slug: string;
    initialStep: string;
    steps: readonly string[];
    resumeOnly?: boolean;
    /** The declared fire path — compared with `deepEqual`, not by `kind` alone. */
    trigger: WorkflowTrigger;
    /**
     * `null` ⇒ the recipe declares no `dedupKey` (no singleton guard). Otherwise
     * one or more `(input → expected key)` samples pinning the derivation. Inputs
     * must be runtime-valid: `learn-skill`/`skill-documentation` `schema.parse`
     * their `input`, so a missing required field throws instead of returning.
     */
    dedup: null | ReadonlyArray<{ input: WorkflowInput; expected: string | null }>;
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
      steps: ["classify", "apply-label"],
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
      // Keyed off `metadata`, not `input`. A settled transcript anchor
      // (thread + arming message) dedups; a run without both is un-guarded.
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
      // Global per-user singleton — a constant key regardless of args.
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
