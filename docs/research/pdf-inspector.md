# `@firecrawl/pdf-inspector` — primary-source research for issue #649

Researched 2026-08-19 against the npm registry API, the package's shipped
`index.d.ts` and README (v1.15.0, installed locally), the
`firecrawl/pdf-inspector` GitHub repository, the `firecrawl/firecrawl`
repository, and the Firecrawl blog. No secondary write-ups were used.

## Verdict

The issue's dependency **holds, with three corrections**:

1. The package exists, is MIT, is actively released (56 versions in 4 months,
   latest 2026-08-17), does ~73k weekly downloads, and powers Firecrawl's own
   Fire-PDF engine. The perf/quality numbers in the issue (~200 ms, ~54%
   text-based, 0.875 on opendataloader-bench) all trace verbatim to the repo
   README — they are Firecrawl's self-reported claims, not third-party
   measurements.
2. **The JS classification labels are PascalCase, not snake_case.** The issue
   claims `"text_based" | "mixed" | "scanned" | "image_based"`; those are the
   Python labels. The JS/TS enum is
   `'TextBased' | 'Scanned' | 'ImageBased' | 'Mixed'`.
3. **Page indexing is mixed, not uniformly 1-indexed.**
   `extractPagesMarkdown` returns per-page markdown with **0-indexed** `page`
   fields; `classifyPdf().pagesNeedingOcr` is 0-indexed; but
   `PdfResult.pagesNeedingOcr`, `pagesWithTables`, and the OCR-path
   `pageNumber` are 1-indexed. Any wrapper must normalize at its boundary.
4. One design caveat: the **core API rejects encrypted PDFs** — a `password`
   option exists only on the optional `processPdfWithOcr` path; password
   support for `classifyPdf`/`processPdf` is an open feature request
   (issues #199, #389).

The "no OCR" premise holds for the deterministic path: `classifyPdf`,
`processPdf`, and `extractPagesMarkdown` never run OCR. An opt-in
`processPdfWithOcr` exists but requires external PDFium/ONNX runtimes that
the package does not embed; unused, it loads nothing.

## 1. Existence and vitals

- Package: `@firecrawl/pdf-inspector`, latest **1.15.0**, published
  **2026-08-17** (`npm view @firecrawl/pdf-inspector`); first release 1.0.0
  on 2026-04-17.
- License: **MIT** (npm metadata and GitHub `license.spdx_id`).
- Weekly downloads: **73,282** for 2026-08-09..15
  (`https://api.npmjs.org/downloads/point/last-week/@firecrawl/pdf-inspector`).
- Repo: <https://github.com/firecrawl/pdf-inspector> (also ships Python,
  Rust crate, CLI, and WASM bindings from the same core).

## 2. Real JS/TS API (from the shipped `index.d.ts`, v1.15.0)

Input is always a Node `Buffer` (bytes, not a path). Main functions:

- `classifyPdf(buffer): PdfClassification` — classification only, README
  claims ~10-50 ms. Returns
  `{ pdfType, pageCount, pagesNeedingOcr /* 0-indexed */, confidence /* 0-1 */ }`.
- `processPdf(buffer, pages?): PdfResult` — classify + extract + markdown.
  Returns `pdfType`, `markdown?`, `confidence`, `processingTimeMs`,
  `pagesNeedingOcr` (**1-indexed**), `ocrReasonsByPage`, `pagesWithTables`,
  `pagesWithColumns`, `isComplexLayout`, `hasEncodingIssues`, `title?`.
- `extractPagesMarkdown(buffer, pages?): PagesExtractionResult` — per-page
  markdown: `pages[]` of `{ page /* 0-indexed */, markdown, needsOcr,
ocrReason? }`, plus 1-indexed `pagesWithTables` / `pagesWithColumns` /
  `pagesNeedingOcr` aggregates.
- Async variants `classifyPdfAsync` / `processPdfAsync` /
  `extractPagesMarkdownAsync` run on the libuv thread pool (the sync forms
  block the event loop; the buffer is copied for the async forms).
- Lower-level: `extractText`, `extractTextWithPositions` (1-indexed
  `TextItem.page`, font/bold/italic/link/MCID metadata),
  `extractTextInRegions`, `extractStructureElements` (tagged-PDF roles),
  and a table-structure-recovery family (`extractTablesInRegions`,
  `extractTablesWithStructure*`, `detectVectorGridInRegion`).

Classification enum (exact):

```ts
export declare const enum PdfType {
  TextBased = "TextBased",
  Scanned = "Scanned",
  ImageBased = "ImageBased",
  Mixed = "Mixed",
}
```

Confidence: yes, `confidence: number` (0-1) on both `PdfClassification` and
`PdfResult`.

Verified live on macOS (v1.15.0): a one-page text PDF returned
`{"pdfType":"TextBased","pageCount":1,"pagesNeedingOcr":[],"confidence":1}`
and `processPdf` produced markdown in `processingTimeMs: 5`. An invalid PDF
throws `Error: classify_pdf: Invalid PDF structure` with
`code: 'GenericFailure'` — callers need a try/catch, not a result check.

## 3. Distribution

NAPI-RS native binaries as per-platform **optionalDependencies** (standard
napi-rs pattern; npm installs only the matching one). From the package
manifest:

| Target            | Package                                     |
| ----------------- | ------------------------------------------- |
| linux x64 glibc   | `@firecrawl/pdf-inspector-linux-x64-gnu`    |
| linux x64 musl    | `@firecrawl/pdf-inspector-linux-x64-musl`   |
| linux arm64 glibc | `@firecrawl/pdf-inspector-linux-arm64-gnu`  |
| linux arm64 musl  | `@firecrawl/pdf-inspector-linux-arm64-musl` |
| darwin arm64      | `@firecrawl/pdf-inspector-darwin-arm64`     |
| win32 x64 msvc    | `@firecrawl/pdf-inspector-win32-x64-msvc`   |

So linux x64/arm64 are covered for **both** gnu and musl. Note: no
darwin-x64 (Intel Mac) build. Each platform package is ~11 MB unpacked
(one `.node` file).

WebAssembly is a **separate package**, `@firecrawl/pdf-inspector-wasm`
(v1.15.0, ~5.1 MB unpacked, "Browser WebAssembly bindings") — it is not an
optionalDependency of the main package and is aimed at browsers/Web Workers.

## 4. Runtime requirements on a Linux server (Railway, Node 24)

- The linux-x64-gnu `.node` binary references dynamic symbols up to
  **GLIBC_2.35** (verified with `strings` on the 1.15.0 tarball). That means
  Ubuntu 22.04+ / Debian 12+; Railway's Railpack Node images are
  Debian-bookworm-based (glibc 2.36), so this is satisfied. The musl build
  covers Alpine if the base image ever changes.
- Platform packages declare `engines.node >= 10`; Node 24 is fine.
- **No postinstall scripts** — the manifest has only `build`/`build:debug`
  dev scripts; install is a plain tarball copy. Platform packages carry npm
  provenance attestations (SLSA v1).
- No system libraries needed for the deterministic path. Only the opt-in
  OCR path requires external PDFium and ONNX Runtime shared libraries
  (`PDFIUM_LIB_PATH`, `ORT_DYLIB_PATH`) plus a downloaded model set; the
  shipped README states the native package embeds none of these and "clean
  `Auto` requests never load or download them".

## 5. Performance and quality claims

All three numbers in issue #649 trace to primary Firecrawl sources:

- "~200 ms" and "~54%": repo README, line 10 — "Built by Firecrawl to
  handle text-based PDFs locally in under 200ms, skipping expensive OCR
  services for the ~54% of PDFs that don't need them."
  (<https://raw.githubusercontent.com/firecrawl/pdf-inspector/main/README.md>)
- "0.875": README benchmark table — opendataloader-bench corpus (200 PDFs),
  overall 0.875, reading order 0.915, tables (TEDS) 0.814, headings 0.788,
  speed 0.470 s; refreshed 2026-07-31 on an Apple M4 Pro, OCR disabled. Raw
  artifacts live in Firecrawl's fork branch
  `firecrawl/opendataloader-bench` (`abi/pdf-parser-benchmark-results`).

Verification status: these are **self-reported by Firecrawl**. The benchmark
methodology and artifacts are published, so the 0.875 is reproducible in
principle; the "~54% of PDFs are text-based" figure comes from Firecrawl's
own crawl corpus and is not independently verifiable. My local smoke test
(1-page PDF, 5 ms) is consistent with the latency claim's order of
magnitude.

## 6. Markdown tables and OCR stance

- **Tables → Markdown: yes.** `processPdf`/`extractPagesMarkdown` emit
  pipe-tables via built-in rectangle-based + heuristic detection and report
  `pagesWithTables`. A separate TSR family accepts external
  structure-recognition output and renders pipe-tables from native PDF text
  ("no OCR involved" per the typedoc).
- **OCR: none in the core path.** Classification/extraction flag pages as
  `needsOcr` with machine-readable `ocrReason`s but never rasterize or run
  a model. `processPdfWithOcr` (OcrMode `Off`/`Auto`/`Force`) is an opt-in
  addition that requires external runtimes; ignoring it preserves the
  issue's "no OCR by design" premise exactly.

## 7. Limitations relevant to #649

- **Encrypted PDFs**: not supported by `classifyPdf`/`detectPdf`/`processPdf`
  — `password` exists only in `OcrOptions`. Open feature requests: #199
  ("accept an optional password on classifyPdf/detectPdf/processPdf") and
  #389 ("extract markdown for pages of an encrypted PDF"). Expect a thrown
  error on encrypted input; handle it.
- **Broken-font / garbled-text detection: yes, first-class.** Per-page and
  per-region `needsOcr` covers "empty, GID-encoded fonts, garbage, encoding
  issues"; `ocrReason` carries labels such as `"suspected_garbled_text"`;
  `PdfResult.hasEncodingIssues` is a document-level flag. This satisfies the
  issue's "broken-font PDF flagged" requirement directly.
- **Max file size / memory**: no documented limit and no open issue found.
  The whole PDF must be a `Buffer` in memory, and the async variants copy
  the buffer (so peak ≥ 2x file size); a huge PDF costs proportional RAM.
  Cap the accepted size at the app boundary.
- **Invalid PDFs throw** (`GenericFailure`), they do not return a
  classification.
- **Indexing inconsistency** (section 2) is the main foot-gun; there is even
  an open issue about the Python side of it (#347).

## 8. Maturity and risk

- GitHub: **16,169 stars**, **73 open issues** + 96 open PRs
  (`gh api repos/firecrawl/pdf-inspector`, search API with `type:issue`),
  repo created 2026-02-06, pushed 2026-08-19 (today).
- Release cadence: 56 npm versions between 2026-04-17 and 2026-08-17 —
  multiple releases per week (npm `time` field).
- **Dogfooded**: Firecrawl's product depends on it — `firecrawl/firecrawl`
  `apps/api/native/Cargo.toml` pins `pdf-inspector = "1.14.2"` and
  `apps/api/src/config.ts` has `PDF_RUST_EXTRACT_ENABLE` /
  `PDF_SHADOW_COMPARISON_ENABLE` flags ("PDF Rust Extraction
  (pdf-inspector)"). The Fire-PDF launch post (2026-04-14,
  <https://www.firecrawl.dev/blog/fire-pdf-launch>) describes it as "our
  open-source Rust library that classifies every page ... in milliseconds,
  without rendering".
- Risk notes: the project is 6 months old and moves fast (minor versions
  weekly); pin the version. Single-vendor governance (Firecrawl). No
  darwin-x64 build if any contributor still uses an Intel Mac.

## Alternatives (for context; not needed given the verdict)

- `unpdf` / `pdfjs-dist`: pure-JS, per-page text, no classification,
  no markdown tables, slower.
- `mupdf` (JS/WASM bindings): AGPL — license mismatch.
- `@hyzyla/pdfium`: rendering-oriented PDFium bindings, no classification.
- `opendataloader-pdf`: Java-core wrapper; heavier runtime, benchmarked
  below pdf-inspector on its own bench.
  None matches the classify-then-extract-with-quality-flags shape the issue
  needs; the proposed dependency is the right one.
