/**
 * Compile-only fixture: no wildcard export for `artifacts`, `tasks`, `skills`, `briefings`,
 * `automation` in `@alfred/assistant`. See `knowledge-subpath-surface.type-test.ts` for the mechanism.
 * Each negative appears twice, because the two wildcard target forms publish disjoint spellings:
 *
 *   "./skills/*": "./src/skills/*.ts"  -> only the extensionless specifiers resolve
 *   "./skills/*": "./src/skills/*"     -> only the `.ts` specifiers resolve
 *
 * `briefings/agent/prompt` is nested: Node's `*` matches across `/`, so a wildcard publishes the subtree.
 */

// @ts-expect-error - `artifacts/external-file` is not an exported subpath; the exports map is the gate.
type _ExternalFile = typeof import("@alfred/assistant/artifacts/external-file");

// @ts-expect-error - `tasks/index` is not an exported subpath; reach the barrel as `@alfred/assistant/tasks`.
type _TasksIndex = typeof import("@alfred/assistant/tasks/index");

// @ts-expect-error - `skills/learn-skill` is not an exported subpath; the exports map is the gate.
type _LearnSkill = typeof import("@alfred/assistant/skills/learn-skill");

// @ts-expect-error - `briefings/agent/prompt` is not an exported subpath; nested, so it proves `*` crosses `/`.
type _BriefingPrompt = typeof import("@alfred/assistant/briefings/agent/prompt");

// @ts-expect-error - `automation/queue` is not an exported subpath; the exports map is the gate.
type _AutomationQueue = typeof import("@alfred/assistant/automation/queue");

/** The same five files, spelled with `.ts`. */

// @ts-expect-error - `artifacts/external-file` is not exported under any spelling; see above.
type _ExternalFileTs = typeof import("@alfred/assistant/artifacts/external-file.ts");

// @ts-expect-error - `tasks/index` is not exported under any spelling; see above.
type _TasksIndexTs = typeof import("@alfred/assistant/tasks/index.ts");

// @ts-expect-error - `skills/learn-skill` is not exported under any spelling; see above.
type _LearnSkillTs = typeof import("@alfred/assistant/skills/learn-skill.ts");

// @ts-expect-error - `briefings/agent/prompt` is not exported under any spelling; see above.
type _BriefingPromptTs = typeof import("@alfred/assistant/briefings/agent/prompt.ts");

// @ts-expect-error - `automation/queue` is not exported under any spelling; see above.
type _AutomationQueueTs = typeof import("@alfred/assistant/automation/queue.ts");

/** One listed subpath per directory, so the negatives cannot pass on a typo. */
type _ContentHash = typeof import("@alfred/assistant/artifacts/content-hash");

type _AssertContentHashResolves = _ContentHash["artifactContentHash"];

type _TasksResolve = typeof import("@alfred/assistant/tasks/resolve");

type _AssertTasksResolveResolves = _TasksResolve["resolveTodosForGmailSource"];

type _SkillRevisions = typeof import("@alfred/assistant/skills/revisions");

type _AssertSkillRevisionsResolves = _SkillRevisions["commitSkillRevision"];

type _BriefingsRead = typeof import("@alfred/assistant/briefings/read");

type _AssertBriefingsReadResolves = _BriefingsRead["listEmailsSinceWatermark"];

type _AutomationReadiness = typeof import("@alfred/assistant/automation/readiness");

type _AssertAutomationReadinessResolves = _AutomationReadiness["canonicalizeWorkflowAccounts"];
