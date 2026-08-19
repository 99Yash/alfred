# Grounded PDF ingestion — actualization plan for issue #649

Status: researched, not started. Sources: issue #649, three seam maps of this repo (2026-08-19),
and the primary-source library research in [docs/research/pdf-inspector.md](../research/pdf-inspector.md).

## Verdict

The issue is buildable. The library dependency holds. But the issue was written against a pre-rename
repo and against two ADRs that do not agree with it. Five of its claims are stale or wrong, and it
hides three pieces of real scope. This plan corrects the names, adjudicates the conflicts, and
sequences the work into campaign items.

## Name map (issue → repo today)

| Issue says | Repo has |
| --- | --- |
| `@alfred/ingestion` | `@alfred/corpus` (`packages/corpus/`); `packages/ingestion/` is untracked build residue |
| `embedDocument` | `indexDocument` (`packages/corpus/src/embed-document.ts:78`) |
| `semanticSearch` | `search` (`packages/corpus/src/search.ts:48`) |
| classification `"text_based" \| "mixed" \| "scanned" \| "image_based"` | JS API returns `'TextBased' \| 'Scanned' \| 'ImageBased' \| 'Mixed'`; snake_case is the Python API |
| "the pure chunker tests in `@alfred/ingestion`" | `chunkText` has zero tests; nearest pure prior art is `packages/corpus/test/db-backed-guard.test.ts` |
| "the same way ADR-0065 requires ffmpeg" | ffmpeg was never added; no Dockerfile or Nixpacks config exists. The real precedent is `sharp` as a plain npm dep |

## Hidden scope the issue does not list

1. **Chat cannot accept a PDF today.** `assertUploadAllowed`
   (`packages/assistant/src/chat/attachments/attachments.ts:139`) rejects every non-image upload.
   Stories 1–7 are unreachable until this gate opens for `application/pdf`.
2. **No agent tool searches the corpus.** `search` has one production caller
   (skill-documentation context). Stories 12, 13, and 15 need a new tool.
3. **Gmail attachment bytes are never fetched.** `messages.attachments.get` is never called;
   attachments are metadata-only chips in the inbox reader. Story 11 needs a new fetch path in
   `@alfred/integrations`.

## Adjudications

These are my calls. Each one deviates from the issue text or settles a conflict it left open.

**D1 — The extractor gets its own package: `@alfred/extraction`.**
Not `@alfred/corpus`. Two reasons. `fetch_url` must not pull `@alfred/db` into the import graph of
every tool (the lazy-import guard comments at `tool-runtime/internal/registry.ts:36` and
`tool-runtime/context.ts:6`), and `@alfred/corpus` imports `@alfred/db`. The extractor is pure
bytes-in, pages-out; its only dependency is `@firecrawl/pdf-inspector` (pinned). Chat, `fetch_url`,
and corpus ingestion all inject or import it without a db edge.

**D2 — Supersede ADR-0039; use new source values, not new tables.**
ADR-0039 decided dedicated `attachments` + `attachment_pages` tables and explicitly rejected the
single-`documents` shape #649 chose. ADR-0039 is unimplemented (no tables, no queue, no module),
but ADR-0045 and ADR-0038 wrongly describe it as shipped. At single-user scale the dedicated-table
family is machinery we do not need: `chunks.metadata.page` preserves the page boundary, and the
`contentHash` churn ADR-0039 feared is exactly the re-embed trigger #649 wants. One of ADR-0039's
rejection reasons is real, though: an attachment row with `source: "gmail"` leaks into the inbox
reader (`packages/http/src/me.ts:563` filters on `source = "gmail"` with no discriminator) and into
the triage and briefing gathers. So attachment documents get their own source value,
`"gmail_attachment"`, and Drive gets `"drive"`. Both need one migration: the `documents_source_valid`
check constraint is built from `DOCUMENT_SOURCES`. The new ADR states all of this and corrects the
stale prose in ADR-0045 and ADR-0038.

**D3 — No representation version bump.**
The issue bumps `CHAT_ATTACHMENT_REPRESENTATION_VERSION` to 2 to drive re-enrichment. But there is
nothing to re-enrich: no PDF representation exists at version 1, because no PDF has ever entered
chat. A bump would blank every existing image representation until the compaction scheduler
re-enriches it — pure churn. Instead, `evidenceSchema` gains an optional nullable `page` field.
The `.strict()` schema still parses old rows because the field is optional. New PDF representations
are new claims at version 1. If a later change makes re-enrichment genuinely necessary, bump then.

**D4 — Same-turn availability comes from ingest-time extraction, not enrichment.**
Enrichment runs only under background compaction pressure, so filling `degradedText` there never
serves story 4 ("use my PDF in the same turn"). The extractor is local, deterministic, and fast
(~200 ms claimed; verify on fixtures). Run it synchronously in the upload ingest path
(`attachment-ingest.ts`), write `degradedText` with `[page N]` markers, and set the row `ready`.
`buildStoredContentParts` already reads `degradedText`, so the live turn gets the pages with no
other change. A scanned PDF gets `degradedText = null` at ingest and an immediate `media.enrich`
enqueue; its answer arrives via the representation, not in the same turn. That edge is accepted and
stated to the user in the tool result. ADR-0065's bounded-await stays unbuilt.

**D5 — The extractor result union grows two failure kinds.**
The issue's two-shape union misses real cases the library research found: encrypted PDFs (the core
API rejects them; `password` exists only on the OCR path) and invalid bytes (`GenericFailure`
throw). The wrapper returns `extracted | needs_ocr | encrypted | invalid`, maps the PascalCase
labels, normalizes all page numbers to 1-indexed (the library mixes 0- and 1-indexed), and carries
the garbled-text flags (`suspected_garbled_text`, `hasEncodingIssues`) so story 23 is served.

**D6 — Page-bounded chunking is a new corpus entry point, not a `chunkText` flag.**
`chunkText`'s overlap logic deliberately bleeds the previous chunk's tail across boundaries. A
chunk that claims page 3 must not carry page 2 text. A new `chunkPages(pages)` in
`@alfred/corpus` calls the existing splitter per page with overlap disabled across pages, and
returns chunks with `{ page }` metadata. `indexDocument` writes `chunks.metadata` and adds
`metadata` to its `onConflictDoUpdate` set, or a re-extraction leaves a stale page on an updated
chunk. Page structure travels from the door to `indexDocument` via `documents.metadata.pages`
(offsets into `content`), not via fragile marker parsing.

**D7 — The attachment door upserts; the Gmail email door stays as it is.**
`gmail-ingest.ts` inserts documents with `onConflictDoNothing`, so re-ingest never updates content.
That is fine for immutable emails. The attachment and Drive doors need
`onConflictDoUpdate` on `(userId, source, sourceId)` updating `content`, `contentHash`, and
`metadata`, then call `indexDocument` directly — the unembedded-sweep only finds documents with
zero chunks, so it never re-indexes a changed document.

**D8 — The corpus search tool is in scope, last.**
Without it, stories 12, 13, and 15 are dead code: the page would sit in `chunks.metadata` with no
reader. `SearchHit` gains `page` (from `chunks.metadata`), and a new read-only tool exposes
`search` to the agent. The tool takes the corpus dependency via injection so the tool graph stays
free of the static `@alfred/db` edge.

## Constraints the implementation must respect

- `pnpm check:web-boundaries` fences by reachability from `apps/web/src`; the NAPI dep is caught
  by `check:web-bundle-graph` if it ever leaks. If `@alfred/extraction` is named in
  `docs/reference/architecture.md` package lists, the marked regions must stay in sync with
  `scripts/web-boundaries.mjs` or `pnpm check` fails.
- The pdf-inspector NAPI binaries arrive as per-platform `optionalDependencies` with no postinstall,
  so no `pnpm-workspace.yaml` `allowBuilds:` entry and no deploy-image change is expected. Verify
  once on Railway (Debian 12, glibc ≥ 2.35 — satisfied). Verify the `.node` file survives the
  `tsdown` bundle of `apps/server` (check externals).
- Fixture PDFs must be git-tracked: the `leaf-db-tests` CI job counts
  `git ls-files "packages/corpus/test"` and a similar count guard should cover the new package.
  Do not use `**` in a bare git pathspec (repo lesson).
- The stale comment in `packages/corpus/tsconfig.test.json` ("the tree holds TWO `*.test.ts`
  files") goes stale the moment a test is added; update it in whichever item touches it first.
- Tests that invert: `fetch-url.test.ts:401-430` (binary refusal + dispose),
  `attachment-enrichment.test.ts:29-43` (schema literal). Inverting them is part of the item that
  changes the behavior, never a separate cleanup.

## Item queue (campaign-ready)

Each item lands as one PR. Prereqs name item numbers.

1. **ADR + prose repair.** Write the new ADR: deterministic-first PDF extraction; supersedes
   ADR-0039; amends ADR-0065 (PDF degrade becomes deterministic at ingest) and ADR-0010
   (`chunks.metadata` carries a page anchor). Correct ADR-0045:7 and ADR-0038:8,54, which describe
   ADR-0039 as shipped. Update `decisions.md`. No code. Prereqs: none.
2. **`@alfred/extraction` package.** Wrap `@firecrawl/pdf-inspector` (pinned) behind
   `extractPdf(bytes): ExtractedPdf` with the D5 union: label mapping, 1-indexed normalization,
   encrypted and invalid kinds, garbled flags, a byte cap argument. Tracked fixture PDFs (one
   born-digital, one scanned). Pure tests against the real binary. Wire the package into the
   checks (knip, tsconfig, CI test job with a file-count guard). Prereqs: 1.
3. **`fetch_url` reads PDFs.** Carve `application/pdf` out of both gates (Content-Type at
   `fetch-url.ts:1211`, sniffer at `:1267`), read the bytes under the existing size cap, call the
   injected `extract` (new member of `FetchUrlDeps`), return page-marked text for `extracted`, and
   typed results for `needs_ocr` / `encrypted` / `invalid` (new `reason` members). Invert the three
   affected tests; keep the NUL-byte refusals. Prereqs: 2.
4. **Chat door: PDF upload + ingest-time degrade.** Open `assertUploadAllowed` for
   `application/pdf` (the `degrade-text` policy already caps it at 10 MB). In the ingest path, run
   `extractPdf` synchronously; on `extracted`, write `degradedText` with `[page N]` markers and set
   `ready`; on `needs_ocr`, leave `degradedText` null, set `ready`, and enqueue `media.enrich`
   immediately; on `encrypted` / `invalid`, fail the upload with a clear message. Assert the new
   `degradedText` shape in `attachment-hydration.test.ts`. Prereqs: 2.
5. **Chat enrichment: extract dependency + page evidence.** Inject `extract` into
   `enrichClaimedChatAttachment`. For a PDF that extracts, build the representation
   deterministically with a `page` on each evidence item and no model call; for `needs_ocr`, fall
   back to `generate` with `page: null`. Add the optional nullable `page` to `evidenceSchema`
   (no version bump — D3). Assert the page survives `buildConversationSummaryEvidence` into the
   summary JSON. Prereqs: 4.
6. **Corpus: page-aware chunks + sources migration.** Add `chunkPages`, write `chunks.metadata.page`,
   extend `indexDocument`'s conflict-update set with `metadata`, and read page structure from
   `documents.metadata.pages`. One migration: add `"gmail_attachment"` and `"drive"` to
   `DOCUMENT_SOURCES` and rebuild the `documents_source_valid` check. Add the missing `chunkText`
   tests while in the file. Prereqs: 2.
7. **Gmail attachment ingestion.** Add `getAttachment` (`messages.attachments.get`) to
   `@alfred/integrations/google`. In `connections/ingestion`, after the email document insert,
   fetch PDF attachments under a byte cap, extract, and upsert a `documents` row per D7:
   `source: "gmail_attachment"`, `sourceId` = message id + attachment id, filename in `metadata`,
   then `indexDocument`. Prove the inbox reader and triage gathers do not see the new rows.
   DB-backed test: ingest, re-ingest changed (re-embeds), re-ingest unchanged (no-op). Prereqs: 6.
8. **Corpus search tool with page citations.** Add `page` to `SearchHit` from `chunks.metadata`.
   New read-only agent tool over `search`, dependency-injected to keep the tool graph free of the
   static db edge. Update `docs/reference/tool-runtime-map.md`. Prereqs: 7.
9. **Drive PDF ingestion.** A background lister finds non-Google PDFs, fetches bytes via the
   existing Drive integration, extracts, and upserts `source: "drive"` rows per D7. Keep
   `maybeSurfaceUnreadableDriveFile` as the live-turn fallback. This is the largest new surface;
   the design phase decides polling cadence and scope (which folders). Prereqs: 6. May be deferred
   without harming items 1–8.

## Out of scope (unchanged from the issue)

OCR of scanned PDFs; deterministic docx/xlsx; chat-upload RAG (chat PDFs stay out of the corpus,
which is also what keeps the story-25 retention rule intact); table-cell citations; exotic-layout
guarantees. Plus, per D4: ADR-0065's bounded-await stays unbuilt.
