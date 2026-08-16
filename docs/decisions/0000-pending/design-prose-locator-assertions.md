# Design: prose locator assertions

## Purpose

The new check `check:prose-locators` asserts that every backticked repo-relative path and every `@alfred/*` specifier in the repo's prose resolves to a file, a directory, or a package that exists. A stale locator in present-tense prose becomes a build failure.

## Why this check exists

The `exports` map gate (`check:exports`) catches a subpath that resolves to no file. It cannot catch prose. ADR-0089 renamed the API packages by ownership. The package `@alfred/api` died. Its name and its old paths still appear in comments and docs. A doc comment that says a module "lives in `@alfred/api`" is now false. Nothing catches it. This check does.

## The residue at HEAD

A survey of the scanned surfaces found the residue that makes the check red before its first fix:

- ~36 inline spans name `@alfred/api` (the dead package) or a subpath under it.
- ~13 path spans name `packages/api` or a moved file. Three are plain stale paths:
  - `smoke-sender-context.ts:7` points at a plan that moved to `docs/plans/triage-briefing-v2-plan.md`.
  - `trajectory.ts:16` points at a script that moved to `packages/ai/src/scripts/replay-diff.ts`.
  - `security-headers.ts:16` points at a Caddyfile that moved to the repo root (`Caddyfile`).
- 8 spans name a gitignored artifact (`.env`, `dist/`). They are real but not tracked.

The check lands red on this residue. The item drains it so the check is green at HEAD.

## What the check asserts

For each inline backtick span in the scanned prose:

- A bare `@alfred/<pkg>` must name a declared workspace package. This treats a package mention as an identity claim, not an import claim.
- An `@alfred/<pkg>/<sub>` subpath must resolve through `<pkg>`'s exports map. The rule matches `restrictedSpecifierFailures` in `oxlint-config.mjs`.
- A repo-relative path must exist in the git-listed tree. A path with a trailing `/` names a directory; it resolves when it contains listed files.
- Any other span (a URL, an npm name, a word) is not asserted.

## Surfaces scanned

1. Markdown prose: `docs/reference/**/*.md`, `docs/README.md`, root `README.md`, `CLAUDE.md`, `CONTEXT.md`, and each workspace's `AGENTS.md` or `CLAUDE.md`.
2. Source comments: `packages/*/src/**/*.ts` and `apps/*/src/**/*.tsx`. Only backtick spans inside comments are read.

The scan strips fenced blocks and design regions. This matches `check-doc-symbols`. Files come from git listing, never from a hand-rolled walk.

## Resolution basis

Resolution goes through git, never `existsSync`. This matches `package-exports.mjs`. One `git ls-files` listing of the whole repo feeds every path check. A path that exists only in the author's worktree must not pass a gate green for a tree nobody else has.

The 8 gitignored artifact spans (`.env`, `dist/`) cannot resolve through git. Each gets an ALLOWED entry with a reason, or a repoint to a tracked path.

## Resolver reuse

The four resolver functions (`specifierKind`, `publishedKey`, `wildcardTargetPath`, `workspaceExportIndex`) currently live inside `scripts/oxlint-config.mjs` and are not exported. They move into `scripts/package-exports.mjs`, the declared shared home for exports resolution. `oxlint-config.mjs` re-exports them, so its behavior does not change. The prose check imports them from `package-exports.mjs`. The subpath semantics stay textually identical.

## Structural exemptions

A span is not asserted when it is not a concrete claim:

1. Placeholder spans. A span that contains `<`, `>`, `...`, `…`, `*`, `{`, `}`, `$`, or `~` is a pattern, not a name.
2. Negative-context spans. When the enclosing paragraph or comment block narrates the locator's absence ("there is no", "does not exist", "not on", "no longer", "was removed", "was deleted", "now deleted", "deletion of", "deletes"), the span is a true statement of absence. A span that recounts the locator's former home ("used to live", "lived in") is also green: history is not a present-tense claim. The paragraph window lets a recount sentence sit inside a deletion narrative without failing.
3. Bare package mentions of a declared workspace. These are identity claims.

## The ALLOWED map

The ALLOWED map mirrors `check-doc-symbols`: it is keyed by file and span, and every entry needs a reason. It covers the gitignored artifact spans only (seven `apps/*/.env` mentions and one `dist/` bundle path). The inherently historical references to the deleted `@alfred/api` resolve through the negative-context markers above, so they never need an ALLOWED entry.

## Files

- New: `scripts/prose-locators.mjs` (the rules), `scripts/check-prose-locators.mjs` (the CLI), `scripts/prose-locators.selftest.mjs` (the fixture tests).
- Edited: `scripts/package-exports.mjs` and `scripts/oxlint-config.mjs` (the move and re-export), `package.json` (a new `check:prose-locators` script after `check:doc-symbols`).
- Reworded: every red span in the residue. Each span either names the current owner or becomes an explicitly historical reference.

## Selftest firing controls

The fixture tests pin the green and red shapes in both directions:

1. A dead subpath on a live package is caught.
2. A dead repo path is caught.
3. A bare package mention of a declared workspace is green.
4. A placeholder span is green.
5. A negative-context span is green.
6. A wildcard subpath that matches the exports family is green.
7. An ALLOWED entry without a reason fails.
8. The live tree is green.

## Gate wiring

`pnpm check` runs `check:prose-locators` after `check:doc-symbols`. The check runs its fixture tests first, then the live tree. This matches `check-package-exports`.
