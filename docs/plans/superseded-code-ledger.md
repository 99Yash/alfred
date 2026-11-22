---
status: in-progress
evidence: "The delete-now batch and the ride-the-cutover rule are the active work; the slice deletions ride the builds named in column 'Leaves at'."
---

# The superseded-code ledger

One inventory of every code block whose governing design a settled decision replaced, with the slice that orders its removal. **The rule that keeps this a one-time exercise:** every future ADR that replaces code appends its rows here, and the cutover slice that builds the replacement deletes the replaced code in the same PR. No block leaves the tree before the slice that replaces its readers — the briefing and triage run on several of them today.

Owner decisions, 2026-11-16/17:

- The class covers default, implicit, and user-authored workflows; provenance is metadata ([workflows.md](../theory/workflows.md)).
- Backfills and repairs move out of the tracked tree; already-run one-off scripts do not stay as product code.
- The DAG column leaves through the ADR-0017 amendment (deletion of settled theory goes through an amendment).
- Inert-but-executed code (the zero-row fold, the flag-off capture) stays until its named slice.
- No package folds: the module-structure plan names mailer, corpus, env, and config as deliberate.

## The delete-now batch (2026-11-17)

| Removed | Why |
| --- | --- |
| `nf_post.jsonl` (2 MB network capture) | Accidental commit; referenced nowhere |
| 9 tracked `journal/` handoff files | The convention moved to gitignored `.handoff/` |
| `node_modules` + lockfile inside `scripts/spikes/code-mode-sandbox/` | Vendored deps have no place in the tree |
| The stale gated draft-send leg of `smoke-boss.ts` | `gmail.send_draft` was deleted on 2026-11-15 (ADR-0126 amendment) |
| 19 backfill + 2 repair scripts (`apps/server/src/scripts/`) | All `-committed`-suffixed, run once, kept locally under gitignored `archive/scripts/` |

Kept: the `@alfred/config` package. It is one tsconfig, but the module-structure plan names it as deliberate build configuration, and the fold touches CI prose, a lint selftest, and every package's `extends` for no behavior change — the same trade the owner declined for mailer and corpus.

## The slice deletions (each leaves at its cutover slice)

| Block | Mass | Live today | Leaves at |
| --- | --- | --- | --- |
| User-model projection chain: `gmail-kind-fold`, `gmail-edge-fold`, projection run, refold, reader, adapters, jobs, trigger consumer | ~2,600 | Runs per inserted mail; `entity_profiles` 133,175 rows, active since 2026-10-30 | ADR-0127 step 3, after step 2 (`readCorrespondents`) |
| `entity_edges` / `entity_co_occurrence` fold | ~200 | Executes nightly; produces 0 rows | ADR-0127 step 3 |
| Kind classifier | ~390 | fold + triage sender kind | ADR-0127 step 3 |
| Triage sender-kind line, floor, flag | ~450 | Live in classify | ADR-0127 decision 6, with triage slice 3 |
| Old graph (`entities`, `entity_relations`): team-graph, entity-graph, extraction graph step | ~950 | Nightly memory extraction writes it; `upsertContactByAlias` resolves standing-instruction targets | ADR-0127 step 3; the target resolver moves to name links (memory §10 step 2) |
| Significance score | ~340 | Briefing attention band, triage known-contact line, mail-facts reader | Readers move at ADR-0127 step 2, delete at step 3 |
| `email_triage.sender_significance_band` column, sync fields | ~30 | Written and synced; the rail renders nothing from it | ADR-0127 step 3 |
| `sender_priors` + conflict second pass | ~400 | Write runs on every classify; 0 user corrections in 1,512 rows | Triage slice 1 unblocks it; the plan holds the write until the slice 3 prompt rewrite |
| Old triage classify prompt + todo rubric | ~1,300 | Live | Triage slice 3 |
| Meeting + sender-kind floors | ~450 | Live | Triage slice 3 |
| Typed-effects instruction matching (`standing-scope`, `floors/standing`, `effective`, the re-match job `rematch*`) | ~850 | Removed (2026-11-22) | Triage slice 4a removed the read side. The save path that still writes targets and effects leaves at slice 4b |
| Todo machinery in triage (`todo-decision`, document ask, close-loop step) | ~600 | Live; the instruction-todo sweep left at slice 4a | Triage slice 7 (follow-up workflow on the `email-triage.classified` seam) |
| `object-links.ts` (`email_interpretation` writer) | ~240 | Live | Triage slice 7 / ADR-0122 slice 3 |
| Object-state union + reducers, verified-pull verifiers, `loop-key.ts`, knowledge loop set, open-ask guard, gather deploy/merge inputs | ~6,500 | `verifyLoops` runs in every briefing | ADR-0122 slices 1–8 |
| `proposeFact` + 0.85 gate, `writeMemoryChunk`/`memory_chunks`, confirmed-only read rule | ~2,000 | Nightly memory extraction in prod | memory §10 steps 1–4 |
| Chat capture extractor (flag off, discards output) | ~240 | Wired, inert | memory §10 step 4 (#399) |
| `workflows.steps` + node-kind schema, `hil_gates`, `on_signal` | ~100 | No runtime reads them | The ADR-0017 amendment (2026-11-17); the migration rides a maintenance slice |

## Already executed (verified 2026-11-16, no leftovers)

The ADR-0125 GitHub tool deletions, the ADR-0126 Google model-tool deletions and `gmail.send_draft`, and the triage `deepen` step are out of the tree. Triage slice 4a (2026-11-22) removed the instruction scope match, the typed effects at read time, the re-match job, and the instruction-todo sweep. ADR-0120's superseded decisions were replaced by ADR-0122 before code change.
