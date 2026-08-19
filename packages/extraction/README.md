# `@alfred/extraction`

The one deterministic reader of PDF bytes. Every door configures its policy once,
then the hot call accepts only bytes:

```ts
import { createPdfExtractor } from "@alfred/extraction";

const extractPdf = createPdfExtractor({
  maxBytes: 20_000_000,
  maxCharacters: 5_000_000,
  maxParseMilliseconds: 15_000,
});

const result = await extractPdf(bytes);
switch (result.kind) {
  case "extracted":
    return result.pages.map((page) => `p${page.pageNumber}: ${page.markdown}`);
  case "text_without_pages":
    return `${result.pageCount} page(s), text without page boundaries: ${result.text}`;
  case "needs_ocr":
    return `${result.pageCount} page(s) require OCR`;
  case "encrypted":
    return "the document is password-protected";
  case "invalid":
    return `not a readable PDF (${result.cause}): ${result.reason}`;
  case "limit_exceeded":
    return result.message;
  default: {
    const _exhaustive: never = result;
    return _exhaustive;
  }
}
```

All three limits are required positive safe integers. `maxBytes` is checked in
the parent before a child starts. `maxParseMilliseconds` must not exceed Node's
timer ceiling of `2_147_483_647`. It covers process startup, the vendor import,
all vendor calls, and the complete reply. When it expires, the parent sends
`SIGKILL`, waits for the child to exit, and ignores any late reply.

`maxCharacters` counts UTF-16 code units in content that crosses the process
boundary:

- `extracted`: every `pages[].markdown.length` plus `text.length`. The overlap
  counts twice because both readings cross the boundary.
- `text_without_pages`: `text.length`.
- other results: zero content characters.

The child checks page markdown before it calls the synchronous `extractText`,
then checks the final public result again before serialization. A breach returns
one `limit_exceeded` value and no partial content. The package does not truncate.
Truncation would make an incomplete document look successful.

## Process boundary

The NAPI vendor runs in a one-shot child process. A promise timeout would settle
only the caller while native work continued. A worker thread would still share
the process libuv pool. The child process isolates the server heap, event loop,
and libuv pool, and it gives the parent a process that it can kill.

The child receives one bounded request and writes one bounded JSON line. The
parent treats the line as `unknown` and validates the full discriminated protocol.
Malformed JSON, more than one reply, trailing data, a pipe overflow, and a
non-zero exit are dependency failures.

The child runs with a 256 MiB V8 heap ceiling. The character cap limits what can
escape the child, but it cannot stop the native vendor from allocating a string
before JavaScript can measure it. Native allocation is therefore not a strict
host-memory cap. The hard deadline and disposable process remain required.

## Reading rules

Every page number is 1-indexed. The vendor mixes index bases, so this package is
the only place that converts them.

`pages` cite and `text` completes. They are two readings of the same document:

- `pages` is the citation anchor. A door uses these page numbers for quotes.
- `text` is the completeness reading. It has no page boundary and overlaps the
  page markdown. A door never concatenates the two.

The vendor `pdfType` is metadata, not the verdict. A readable page makes the
result `extracted`. If no page reads but the document text reads, the result is
`text_without_pages`. If no surface reads text, the result is `needs_ocr`.

Encrypted and parser-rejected bytes are values. A missing native binary remains
a native-load rejection. A non-vendor parser fault remains `PdfExtractionError`.

## Vendor pin

`@firecrawl/pdf-inspector` is pinned to an exact version. The vendor reports
encrypted and invalid inputs with the same `GenericFailure` code, so this package
must use message text to distinguish those two result kinds. A vendor message
change must therefore produce a failing fixture test before it can change the
public result. Do not add a range operator to the catalog version.

## Deployment

`apps/server` bundles `@alfred/*` sources, but the native vendor stays external.
The server therefore declares both `@alfred/extraction` and
`@firecrawl/pdf-inspector` and emits `dist/extract-pdf-child.js` as a separate
entry beside `dist/index.js`. CI builds and runs this emitted child so a missing
entry cannot reach deployment unnoticed.

The vendor has no `darwin-x64` build. Apple Silicon and the Linux glibc target
used by CI and Railway are supported. Its platform packages have no postinstall
script, so no workspace build allow-list entry is needed.
