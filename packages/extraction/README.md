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
  case "text_without_pages":
    // Real text, and no page number for it. Cite the document, never a page.
    return `${result.pageCount} page(s), text without page boundaries: ${result.text}`;
  case "needs_ocr":
    return `${result.pageCount} page(s) no reader could read; OCR is the only way in`;
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

**The evidence decides the variant, not the vendor's `pdfType`, and not one
vendor surface either.** `pdfType` is a whole-document prediction behind a
text-density threshold, and it is wrong in both directions: an `ImageBased` scan
can carry a readable born-digital cover page, and a `TextBased` document at
confidence 1.00 can yield empty markdown on every page. `extractPagesMarkdown` is
not the last word either: a scan with an invisible OCR text layer — what an office
copier produces — returns empty markdown on every page while `extractText` returns
the whole document. So `extractPdf` reads three surfaces in a fixed order:

1. any page holds text → `extracted`, with every page in `pages`;
2. otherwise `extractText` holds text → `text_without_pages`, carrying that text
   and **no page number**, because nothing said which page it came from;
3. otherwise → `needs_ocr`, meaning no surface of the library read one character.

Each of the three has a tracked fixture, and `needs_ocr` has a negative control:
`scanned-single-page.pdf` and `scanned-with-text-layer.pdf` show the same
per-page evidence and get different answers. `pdfType` is metadata a door may
show, never a verdict.

**Every outcome that depends on the bytes is a value, so no door needs a
`try`/`catch` to read a document.** Encrypted, scanned, damaged, unreadable and
oversized bytes are all variants of `ExtractedPdf`. That holds for **every**
failure the vendor's parser raises, not the ones this package thought of: a PDF
copied in text mode fails with `"PDF parsing error: couldn't parse input: invalid
file trailer"`, a message no substring table written before it could match, and it
still returns `invalid` carrying that reason. The vendor's message vocabulary is
open, so the message chooses `encrypted` over `invalid` and nothing more.

`extractPdf` still throws, in two cases, and both mean a dependency problem rather
than a fact about the document:

1. the native binary cannot load — no platform build, or a failed
   optional-dependency install;
2. an error that is not a vendor parser failure escapes — an out-of-memory, a
   programming error, an unrelated host fault. Reporting one of those as "your PDF
   is corrupt" is what this rethrow prevents.

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
message substring is the only way to tell an encrypted PDF from a corrupt one — and
that is the only question the message answers here. The version is therefore pinned
with no caret, and `test/fixtures/` holds a document for it: a reword becomes a red
CI row instead of Alfred telling somebody their password-protected statement is a
corrupt file.

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
