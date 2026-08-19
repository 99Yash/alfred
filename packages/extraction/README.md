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
}
```

## Two rules the package exists to hold

**Every page number is 1-indexed.** The library is not: it reports OCR pages
0-indexed from `classifyPdf` and 1-indexed from `extractPagesMarkdown`, for the
same document. One module owns that conversion, so a page number Alfred states to
a user is a real page.

**A value describes the input, a throw describes the installation.** Encrypted,
scanned, unreadable and oversized bytes are all variants of `ExtractedPdf`, so no
door needs a `try`/`catch`. `extractPdf` throws only when the native binary cannot
load, which is a dependency outage rather than a fact about the document.

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

## The server bundle

`apps/server` bundles every `@alfred/*` package with tsdown, so this package's
source is inlined there. A native module cannot be inlined, so
`@firecrawl/pdf-inspector` is also a direct dependency of `apps/server`, listed in
that app's tsdown `external`, and excused in `knip.json`. This is the same shape
`sharp` uses, for the same reason.
