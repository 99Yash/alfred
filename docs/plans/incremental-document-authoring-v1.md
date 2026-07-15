# Incremental document authoring — v1 plan (ADR-0085, Gap 2)

**Status:** IMPLEMENTED and **live re-probe PASSED (2026-07-14)** — the acceptance gate is met. Code + unit/write-path tests green, `pnpm check-types` clean. See "Live re-probe results" at the bottom.
**Depends on:** ADR-0075 (artifact epic), Gap 1 / #511 (stream-timeout retry — this structurally supersedes it for documents).
**Branch context:** grilled + designed on `fix/chat-turn-timeout-retry`; implemented on the same branch's working tree (the plan's "fresh branch off main" note predates knowing #511 is itself still unmerged — sequence the PRs so this lands after or alongside #511).

---

## Problem (one line)

`document` artifacts are authored in a single `create_artifact` call carrying the whole markdown body — a ~3,300-word report ran as **one 118.1s generation** (66% of the 180s stream ceiling). A slightly longer document times out, and the Gap 1 retry just re-runs the same one-shot. `document` is the only authorable kind with no bounded, incremental path; `pages` already self-chunks by construction.

## Fix (one line)

Give `document` the same `create` → `append` shape as `pages`: add `system.append_artifact_section({ artifactId, markdown })`, cap per-call markdown at 12K chars on both `create` and `append`, and rewrite the `create_artifact` document-branch description to steer proactive section-by-section authoring. No DB migration.

---

## The mechanism, stated honestly (read this before implementing)

**The per-call cap is a backstop, not the forcing function.** A tool call's arguments stream out of the model, and the 180s ceiling is an `AbortSignal.timeout` on that stream (the Gap 1 mechanism). For a document big enough to actually time out, the abort fires **mid-argument-generation, before a complete tool call is emitted and Zod-validated** — so the cap never runs on the case it exists to fix. What the cap actually does: (1) hard-bounds any single stored write, and (2) forces a *non-compliant-but-sub-timeout* document (finishes under 180s but > 12K) to chunk, keeping behavior uniform.

**The tool description is the load-bearing mechanism.** It must induce the model to *proactively* author section-by-section so no single generation is oversized. This is why acceptance is gated on a live re-probe of a document **sized to time out as a one-shot** proving proactive chunking — not on a schema test of the cap. If the probe shows the model one-shotting past the description, the escalation lever is a mid-stream argument-size abort (ADR-0085 alt (d)), not a bigger cap.

Why `pages` doesn't have this problem and `document` did: `pages`'s `create` structurally *cannot* carry page content (it seeds an empty list) and each page is a naturally bounded unit, so the model chunks by construction. A document section is a *discretionary* unit — the shape enables chunking, the description must induce it.

---

## Implementation

### 1. Shared cap constant — `packages/contracts/src/artifacts.ts`

Add, near the content schema:

```ts
/**
 * Per-call markdown budget for authoring a `document` (ADR-0085). Bounds one
 * create_artifact/append_artifact_section INPUT (~1,800 words ≈ ~60s of
 * generation ≈ ⅓ of the 180s stream ceiling) so a long document is authored as
 * many capped sections that accrue into one body. The STORED total stays
 * `DOCUMENT_MARKDOWN_MAX` (500K). Calibrated from a single 196 chars/s probe —
 * tunable after the live re-probe.
 */
export const ARTIFACT_SECTION_MAX_CHARS = 12_000;
```

Also extract the existing `500_000` document-markdown bound into a named constant (`DOCUMENT_MARKDOWN_MAX = 500_000`) and reference it from `artifactContentSchema` so the stored cap has one source too. The stored 500K is **unchanged**.

### 2. Schemas — `packages/contracts/src/tool-schemas.ts`

- **`createArtifactInput.markdown`**: change `.max(500_000)` → `.max(ARTIFACT_SECTION_MAX_CHARS)`. Rewrite the `.describe(...)` to: "Opening section for a `document` (≤~1,800 words). Author the first section here; continue with `append_artifact_section` — each section renders in the sidebar as produced. Do not attempt the whole document in one call. Invalid for `pages`." Keep it `.optional()`.
- **New `appendArtifactSectionInput`** (mirror `appendArtifactPageInput`, markdown-only — the model writes its own `##` headings):

```ts
export const appendArtifactSectionInput = z
  .object({
    artifactId: z
      .string()
      .min(1)
      .describe("The artifactId returned by create_artifact. Must be a `document` artifact."),
    markdown: z
      .string()
      .min(1)
      .max(ARTIFACT_SECTION_MAX_CHARS)
      .describe(
        "One section of markdown (≤~1,800 words), appended to the end of the document with a blank line. Write your own `##` headings. Split at block boundaries and keep each section self-contained — close every code fence and finish every list/table within the section, because the sidebar re-renders the whole document as each section arrives. Call again for each subsequent section; also use this to add to a document from an earlier turn.",
      ),
  })
  .strict();
```

- **`TOOL_INPUT_SCHEMAS`**: add `"system.append_artifact_section": appendArtifactSectionInput`.

### 3. Tool name + labels — `packages/contracts/src/tools.ts`

- `INTEGRATION_ACTIONS.system`: add `"append_artifact_section"` (this auto-extends the derived `ToolName` union → TypeScript then *forces* the two entries below).
- `TOOL_LABELS`: add `"system.append_artifact_section": { running: "Writing a section", done: "Wrote a section", title: "write a document section" }` (mirror the `append_artifact_page` copy).

### 4. Tool declaration — `packages/api/src/modules/tools/system.ts`

- Add a `liveTool({ integration: "system", action: "append_artifact_section", riskTier: "no_risk", ... })` after `append_artifact_page` (`:445-457` is the template). Description: "Append one section of markdown to a `document` created with create_artifact. Call once per section, in order; also use it to extend a document from an earlier turn. Each section renders in the sidebar as you add it." `execute` resolves `resolveArtifactContext(ctx)` then calls `appendArtifactSection`.
- **Rewrite the `create_artifact` description** (`:436-437`) document branch: "…for a `document` author the opening section here (≤~1,800 words) and continue with `append_artifact_section` — do not attempt the whole document in one call; for `pages` follow with append_artifact_page per page." Leave the `pages` half untouched (the A-trap).

### 5. Write path — `packages/api/src/modules/artifacts/write.ts`

Add `appendArtifactSection`, template = `appendArtifactPage` (`:121-191`). Key differences and **the guard the design nearly missed**:

```ts
export type AppendArtifactSectionResult =
  | { ok: true; artifactId: string; contentChars: number }
  | {
      ok: false;
      status: "not_found" | "wrong_kind" | "content_limit";
      reason: string;
    };

export async function appendArtifactSection(
  ctx: ArtifactWriteContext,
  input: { artifactId: string; markdown: string },
): Promise<AppendArtifactSectionResult> {
  const result = await db().transaction(async (tx) => {
    const [row] = await tx
      .select({ kind: artifacts.kind, content: artifacts.content })
      .from(artifacts)
      .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.userId, ctx.userId), eq(artifacts.threadId, ctx.threadId)))
      .for("update");

    if (!row) return { status: "not_found" as const };
    if (row.kind !== "document" || !row.content || row.content.kind !== "document") {
      return { status: "wrong_kind" as const };
    }

    const current = row.content.markdown;
    const separator = current.length > 0 ? "\n\n" : "";
    const next = current + separator + input.markdown;
    // REQUIRED guard: write.ts does NOT Zod-validate content before the DB write
    // (`.$type<>()` is compile-time only), so the stored 500K cap must be
    // enforced by hand here, exactly as appendArtifactPage guards MAX_PAGES.
    if (next.length > DOCUMENT_MARKDOWN_MAX) return { status: "content_limit" as const };

    await tx
      .update(artifacts)
      .set({ content: { kind: "document", markdown: next }, rowVersion: sql`${artifacts.rowVersion} + 1` })
      .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.userId, ctx.userId), eq(artifacts.threadId, ctx.threadId)));
    return { status: "ok" as const, contentChars: next.length };
  });

  // map statuses → { ok:false, reason } like appendArtifactPage; content_limit
  // reason: `a document holds at most ${DOCUMENT_MARKDOWN_MAX} characters`.
  if (result.status === "ok") emitReplicachePokes([ctx.userId]);
  // ...
}
```

Notes:
- **No `runId` guard** (matches `appendArtifactPage`): appending is additive and row-locked, so cross-turn "extend this document" is safe with no `baseContentHash`. Accept the same provenance latitude `append_artifact_page` already has — a cross-turn append leaves the artifact's `messageId`/`runId` on the original authoring turn and status stays `complete`. Acceptable for v1; do not reset status to `generating` on a cross-turn append.
- Return `contentChars` (accumulated total) so the model has budget feedback across appends.
- `document` `create` seeds `markdown ?? ""` today (`:78-79`) — unchanged; empty-create + all-append is a valid path.

### 6. Registration completeness checklist

Adding to `INTEGRATION_ACTIONS.system` makes the type checker demand the rest — but verify each:
- [x] `INTEGRATION_ACTIONS.system` (drives `ToolName`)
- [x] `TOOL_LABELS` entry (type-forced by `Record<ToolName>`)
- [x] `TOOL_INPUT_SCHEMAS` entry (type-checked by `satisfies Partial<Record<ToolName>>`)
- [x] `appendArtifactSectionInput` schema
- [x] `ARTIFACT_SECTION_MAX_CHARS` + `DOCUMENT_MARKDOWN_MAX` constants
- [x] `liveTool({...})` in the `system.ts` array
- [x] `appendArtifactSection` + `AppendArtifactSectionResult` in `write.ts`
- [x] `create_artifact` description + `createArtifactInput.markdown` cap change
- [x] **`ARTIFACT_MUTATION_TOOL_NAMES` in `chat-turn.ts`** — the item this plan originally missed. Section appends mutate one shared body, so they MUST run in the ordered artifact-mutation lane; the `SELECT … FOR UPDATE` row lock prevents lost writes but NOT reordering, so concurrent same-turn appends would scramble the document without this. Covered by a new case in `artifact-mutation-order.test.ts`.
- [x] `pnpm check-types` on a fresh tree (repo invariant) — clean, 13/13 packages
- [x] Unit + write-path tests green — `test/artifacts/append-section.test.ts` (4 schema, always-run; 6 DB-backed write-path, opt-in) + the section case in `test/agent/artifact-mutation-order.test.ts`

---

## What this does NOT fix (scope honesty)

- **Large-document EDITS.** `update_artifact` full-replacement keeps the 500K cap and stays a single re-emit that can still time out. `append_artifact_section` covers *additive* cross-turn extension; mid-document **surgical** edits remain deferred (v1 flows through full replacement).
- **The single-dense-artifact / resume timeout.** That is thinking-overrun on one unit → per-turn effort sizing (#478) + Gap 1 retry, a different failure mode. This design will not claim to fix it.
- **Truly huge documents** where even proactive per-section authoring is too many turns → server-side decomposition (ADR-0085 alt (e)), framed-future.

---

## Verification (per `project_agent_change_verification` + the spend mandate)

1. **Schema unit test** — extend the tool-input-schema test: `createArtifactInput` and `appendArtifactSectionInput` reject markdown > `ARTIFACT_SECTION_MAX_CHARS`; `appendArtifactSectionInput` requires a non-empty `artifactId` + `markdown`.
2. **Write-path test** (DB-backed, `@alfred/api`): `appendArtifactSection` concatenates with `\n\n`; refuses a `pages` artifact (`wrong_kind`); refuses accumulation past `DOCUMENT_MARKDOWN_MAX` (`content_limit`); serializes concurrent appends (row lock) preserving every section.
3. **Live re-probe — the acceptance gate.** Drive the real chat (chrome-devtools, authed) and read `agent_steps` + `agent_runs.state.toolCallsLog` (probe recipe below):
   - **(a)** Re-run the exact ~3,300-word Silk Road report. Confirm it now authors as `create` + N bounded `append_artifact_section` calls, each generation well under the ceiling (vs the 1-gen/118s baseline).
   - **(b) The case the cap can't backstop:** request a document **large enough to time out as a one-shot** (e.g. a ~6,000-word / ~40K-char deep report). Confirm the model **proactively chunks** rather than one-shotting into a mid-generation timeout. This is what proves the description is doing its job. If it one-shots and times out, the design is insufficient → escalate to mid-stream arg-abort (alt (d)).
4. **Replay-diff** — paired trajectory diff on real runs (`scripts/replay-diff.ts`): assert the tool-call sequence and end state, not prose.
5. **Regression check** — the Silk Road-sized document still completes (no worse), and `pages` authoring is untouched.

### Probe recipe (dev stack + pg)
- Runs link to threads via `agent_runs.metadata->>'threadId'` + `workflow_slug = '__chat-turn__'` (no `thread_id` column); `artifacts` carries `thread_id` + `run_id`; `agent_steps` cols: `step_id`/`attempt`/`status`/`started_at`/`ended_at` (count `chat-turn` rows = generations). `agent_runs.state.toolCallsLog` = ordered tool calls.
- Run any `pg` script FROM `packages/db/` so ESM resolves `pg@8.20.0`; `DATABASE_URL` from `apps/server/.env`; delete the scratch script after (don't leave it in the tree).

---

## File:line map (verified 2026-07-14)

- Tool decls + descriptions: `packages/api/src/modules/tools/system.ts:430-470` (create `:436-437`, append_page `:449-450`, update `:462-463`).
- Input schemas: `packages/contracts/src/tool-schemas.ts:1521-1608` (`createArtifactInput` `:1521`, `appendArtifactPageInput` `:1556`, `updateArtifactInput` `:1575`); `TOOL_INPUT_SCHEMAS` `:1616-1669`.
- Content/kind schemas + stored 500K: `packages/contracts/src/artifacts.ts` (`artifactContentSchema` `:70-73`, document `max=500_000` `:71`, `emptyArtifactContent` `:77`).
- Tool name/labels: `packages/contracts/src/tools.ts` (`INTEGRATION_ACTIONS.system` `:40-51`, `ToolName` derive `:76-78`, `TOOL_LABELS` `:181`, artifact labels `:254-267`).
- Write/persist: `packages/api/src/modules/artifacts/write.ts` (`createArtifact` `:73`, `appendArtifactPage` row-lock txn `:121-191` — the template, `updateArtifact` `:200`, `finalizeRunArtifacts` `:315`).
- Read/context: `packages/api/src/modules/artifacts/read.ts` (`buildThreadArtifactsContext` `:72`, `buildArtifactReference` `:36`).
- Stream/step mechanism: `packages/ai/src/agent.ts:257` `stopWhen: isStepCount(1)` + `DEFAULT_TURN_STREAM_TIMEOUT = { chunkMs: 30_000, totalMs: 180_000 }` `:126`. Each `streamTurn` = one generation with its own ceiling; the executor re-invokes per tool round → each append lands in its own bounded generation.

---

## Live re-probe results (2026-07-14, Auto/Sonnet, Autopilot) — ACCEPTANCE GATE PASSED

Thread `ca2096df-…`, run `run_9486mcs34vyq`, prompt = "comprehensive Silk Road economic history, ≥6,000 words." This is Verification §3(b): a document sized to one-shot-timeout.

**Proactive chunking (the thing the description had to induce).** The model decided *before generating* — its opening thought: _"I'll create this as a document artifact with multiple sections appended one by one."_ It then authored `create_artifact` (opening section) + **8 successful `append_artifact_section` calls**, body accreting 7,088 → 13,460 → 18,470 → 27,042 → 34,597 → 40,455 → 49,641 → **59,740 chars** (~9,000 words). Final artifact `status=complete`, run `status=completed`. That is ~2.9× the 3,300-word baseline that previously ran as one 118.1s generation.

**No stream timeout.** Every successful `chat-turn` generation was well under the 180s ceiling: 52.3, 35.8, 26.8, 63.7, 47.8, 39.1, 32.3, 47.8, 72.8, 48.4, 10.7s. **Max = 72.8s (40% of ceiling).**

**The 12K cap fired as designed (backstop) — and drove a calibration change.** Two `append_artifact_section` calls were rejected `invalid_input` → `{code:"too_big", maximum:12000, path:["markdown"]}`; the model self-corrected each time (next call succeeded). Successful sections ran 5K–10K chars. Because "~1,800 words" of markdown is ~11–13K chars, the 12K cap under-fit its own guidance → ~20% reissue rate. **Raised `ARTIFACT_SECTION_MAX_CHARS` 12K → 15K** to give the stated word target headroom (15K ≈ ~75s, still under half the ceiling). The description guidance stays "~1,800 words."

**Rendering.** The accumulated document rendered cleanly in the sidebar — 55 headings/subheadings (1. Origins … 10. Belt and Road … Conclusion), no error copy, no bare-fence `MarkdownRenderer` crash. Self-contained sections held across every re-render.

**One unrelated anomaly (not ADR-0085).** One `chat-turn` step (attempt 6) failed after 311.7s with `{reason:"lease_reclaimed","message":"lease reclaimed: previous worker presumed dead"}` — a local-dev worker-lease reclamation (the stack had just been restarted), NOT a stream-timeout and NOT an `error_kind`. The executor recovered it (attempt 7 completed and produced the next section) and the run finished clean. It correlated with the first `too_big` rejection (a long recovery turn), which is a second, softer argument for the higher cap. Flagged as dev-infra noise; re-observe in a clean stack if it recurs.

**Verdict:** the description induces proactive section-by-section authoring on a timeout-sized document; the cap backstops oversized sections into self-correcting reissues; no timeout, clean render, clean finalize. Escalation to alt (d) (mid-stream arg-abort) is **not** needed.
