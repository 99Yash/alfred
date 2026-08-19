# `@alfred/extraction`

The one deterministic reader of a PDF's bytes. `extractPdf(bytes, { maxBytes })`
takes bytes and returns pages. Nothing else in the repo calls
`@firecrawl/pdf-inspector`.

```ts
import { extractPdf } from "@alfred/extraction";

const result = await extractPdf(bytes, { maxBytes: 20_000_000 });
switch (result.kind) {
  case "extracted":
    return result.pages.map((page) => `p${page.pageNumber}: ${page.markdown}`);
  case "needs_ocr":
    return `${result.pageCount} scanned page(s); no text to read`;
  case "encrypted":
    return "the document is password-protected";
  case "invalid":
    return `not a readable PDF: ${result.reason}`;
  case "too_large":
    return `${result.byteLength} bytes is above the ${result.maxBytes} byte cap`;
  default: {
    // Copy this arm. It is what makes "a door handles every outcome" a compile
    // error rather than a convention: add a variant, and this line stops
    // compiling in every door until each one handles it.
    const _exhaustive: never = result;
    return _exhaustive;
  }
}
```

## Three rules the package exists to hold

**Every page number is 1-indexed.** The library is not: it reports OCR pages
0-indexed from `classifyPdf` and 1-indexed from `extractPagesMarkdown`, for the
same document. One module owns that conversion, so a page number Alfred states to
a user is a real page. `pageCount` on `extracted` is `pages.length`, so
`pages[pageCount - 1]` always exists.

**The pages decide the variant, not the vendor's `pdfType`.** `pdfType` is a
whole-document prediction behind a text-density threshold, and it is wrong in both
directions: an `ImageBased` scan can carry a readable born-digital cover page, and
a `TextBased` document at confidence 1.00 can yield empty markdown on every page.
Both are tracked fixtures. So `extractPdf` always runs the per-page extraction and
reports `needs_ocr` only when no page held text; `pdfType` is metadata a door may
show, never a verdict.

**Every outcome that depends on the bytes is a value, so no door needs a
`try`/`catch` to read a document.** Encrypted, scanned, unreadable and oversized
bytes are all variants of `ExtractedPdf`.

`extractPdf` still throws, in two cases, and both mean a dependency problem rather
than a fact about the document:

1. the native binary cannot load — no platform build, or a failed
   optional-dependency install;
2. the library fails with a message this package does not recognize. Mapping every
   unrecognized failure to `invalid` would report a broken install or an
   out-of-memory as "your PDF is corrupt", so it rethrows instead.

A door that wants to survive both reports the throw on its dependency-outage path.

## Platforms

`@firecrawl/pdf-inspector` ships its parser as a NAPI binary, one per platform,
delivered through `optionalDependencies`. There is **no `darwin-x64` build**: on an
Intel Mac this package cannot run locally, and `extractPdf` rejects on its first
call with `Cannot find native binding`. Every other target this repo uses is
covered — `darwin-arm64` for Apple Silicon, and `linux-x64-gnu` for CI
(`ubuntu-latest`) and for Railway (Debian 12, glibc 2.36, above the binary's 2.35
floor).

No platform package runs a `postinstall`, so there is no `pnpm-workspace.yaml`
build-allow entry to maintain.

## Why the vendor is pinned exactly

Every library failure arrives as `Error` with `code: "GenericFailure"` and a
message shaped `"<rust_fn>: <reason>"`. There is no typed error class, so the
message substring is the only way to tell an encrypted PDF from a corrupt one. The
version is therefore pinned with no caret, and `test/fixtures/` holds one document
per message: a reword becomes a red CI row instead of Alfred telling somebody their
password-protected statement is a corrupt file.

The pin lives in the `pnpm-workspace.yaml` `catalog:` block, and both manifests
that need it — this package and `apps/server` — say `"catalog:"`. Two manifests
with the same literal could be bumped one at a time, which would leave these
fixtures green against a build the server does not load.

## The server bundle

`apps/server` bundles every `@alfred/*` package with tsdown, so this package's
source is inlined there. A native module cannot be inlined, so
`@firecrawl/pdf-inspector` is also a direct dependency of `apps/server`, listed in
that app's tsdown `external`, and excused in `knip.json`. This is the same shape
`sharp` uses, for the same reason.
