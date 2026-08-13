/**
 * Compile-only fixture: `@alfred/assistant`'s `exports` map is the gate on which
 * `artifacts`, `tasks`, `skills`, `briefings` and `automation` subpaths a caller
 * outside the package may resolve.
 *
 * `packages/assistant/package.json` lists one key per supported subpath for these
 * five directories and NO wildcard for any of them, so a file the manifest does not
 * name fails module resolution. The mechanism, the Tier-1 claim, and the reason this
 * file lives in `packages/http` rather than in `packages/assistant/test/` are all
 * recorded in the sibling fixture `knowledge-subpath-surface.type-test.ts`. Read that
 * header; this one states only what is specific to these five directories.
 *
 * Each negative below appears TWICE, extensionless and with `.ts`, because the two
 * wildcard target forms republish disjoint specifier sets:
 *
 *   "./skills/*": "./src/skills/*.ts"  -> only the extensionless specifiers resolve
 *   "./skills/*": "./src/skills/*"     -> only the `.ts` specifiers resolve
 *
 * Pinning one spelling leaves the other free. No manifest in this repo uses the
 * extensionless form today — every surviving wildcard target carries `.ts` — but
 * nothing rejects the extensionless form either, so both halves stay pinned.
 *
 * `briefings/agent/prompt` is the load-bearing negative of the five. It sits one
 * directory DOWN from `src/briefings/`, so it proves the property that makes a
 * wildcard a Tier-5 surface: Node's `*` matches across `/`, so `"./briefings/*"`
 * published every file in the subtree, not just the directory's own files.
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

/** The same five files, spelled WITH `.ts`. See the header for why both halves exist. */

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

/**
 * The positive half, one per directory, taken from the concrete keys the manifest
 * now names. Each dereferences a real exported name, so a negative above cannot pass
 * because of a typo or a missing dependency rather than because of the exports map.
 */
type _ContentHash = typeof import("@alfred/assistant/artifacts/content-hash");
type _AssertContentHashResolves = _ContentHash["artifactContentHash"];

type _TasksResolve = typeof import("@alfred/assistant/tasks/resolve");
type _AssertTasksResolveResolves = _TasksResolve["resolveTodosForGmailSender"];

type _SkillRevisions = typeof import("@alfred/assistant/skills/revisions");
type _AssertSkillRevisionsResolves = _SkillRevisions["commitSkillRevision"];

type _BriefingsRead = typeof import("@alfred/assistant/briefings/read");
type _AssertBriefingsReadResolves = _BriefingsRead["listEmailsSinceWatermark"];

type _AutomationReadiness = typeof import("@alfred/assistant/automation/readiness");
type _AssertAutomationReadinessResolves = _AutomationReadiness["canonicalizeWorkflowAccounts"];
