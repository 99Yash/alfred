# ADR-0105 — A source declares the media it can return, and the boundary holds every card to that declaration

**Status.** Accepted. Issue #429, epic #422. `mediaKinds` is required on `retrievalSourceManifestSchema`, and `cardObeysManifest` runs in both phases of `searchContext`.

## Decision

Each registered Context Search source declares the payload modalities it can return. `mediaKinds` moves out of the catalog-reserved set of ADR-0101 and becomes required on `RetrievalSourceManifest`, with at least one member. The boundary then holds every card to the declaration of the source that produced it.

Issue #429 asked for media-wide `EvidenceCard` support. The contract half was already built: #423 gave the card a `mediaKind` and an `anchors` list, and the packer renders an anchor line. The production half was missing. Three of four adapters wrote a constant `mediaKind`. No manifest declared `mediaKinds`. No adapter minted an anchor. The Drive adapter gave a PDF, an image and a video the same note, and that note said Drive "cannot return its contents as text".

This decision closes the production half. It does not add an extraction lane. The issue asks for media support "without full media extraction on day one", so a picture, a recording and a film each become a card with the correct modality and an honest note. Alfred reads no bytes and runs no OCR in this slice.

### What a card says after this change

| Record                                    | Modality               | What the card carries                          |
| ----------------------------------------- | ---------------------- | ---------------------------------------------- |
| A message body in the corpus              | `text`                 | The extracted slice                            |
| A file row in the corpus, pages unproven  | `document`             | The extracted slice                            |
| A file row in the corpus, page proven     | `page` + a page anchor | The extracted slice and the page number        |
| A Drive file Drive exports as text        | `text` or `document`   | The exported text                              |
| A Drive PDF                               | `document`             | The file, plus a note about the absent lane    |
| A Drive image, recording or film          | `image`/`audio`/`video`| The file, plus a note about the absent lane    |
| A Drive Form, Site or Script              | `unknown`              | The file, plus the provider export limit       |
| A Drive file whose type Drive did not send | `unknown`             | The file, plus a note about the absent type    |

## Sub-decisions

1. **`mediaKinds` is REQUIRED on the retrieval subtype, because silence must buy nothing.** `retrievalSourceManifestSchema` already requires a read capability and an authority above `unknown`. A modality declaration joins them. The boundary rejects a card whose modality its own source never declared, so an optional list would make silence the one declaration that admits every modality. A source states what it can return, and its cards are then held to that statement. `SourceManifest` stays loose for the catalog case: an MCP server that describes itself in one field still says nothing about what it holds.

2. **The check is a manifest JOIN, so it lives at the boundary and not in the card schema.** `cardObeysManifest(card, source)` in `context-search/registry.ts` joins the two promises a source makes about a card: the card names the source id that registered, and the card carries a modality the manifest declares. Neither is a property of a card alone, because each compares the card against a declaration the card does not carry. The two share one `error` path, because the recovery is the same: a source and its declaration disagree, and one of the two is wrong.

3. **Both phases call the same predicate.** The collect loop in `search.ts` called the identity half inline. `runExpansion` in `expand.ts` called it too. Both now call `cardObeysManifest`. The expansion phase mints a replacement card after the rank, so a check in the collect loop alone would leave the refresh as a way into the pack for a card the collect loop would have rejected.

4. **One owner derives a modality from a MIME type.** `mediaKindForMimeType(mime)` in `@alfred/contracts` reads the IANA top-level type as the modality for `image`, `audio`, `video` and `text`, keeps a list for the `application/*` grab-bag and the Google Workspace namespace, reads the RFC 6838 structured-syntax suffixes (`+json`, `+xml`, `+yaml`) as text, and answers `unknown` for everything else. It is a reading of the TYPE and never a claim about extraction: an `image` answer says the record is a picture, not that an OCR lane exists. It never returns `page`.

    `unknown` covers two silences on purpose, and a Google Form is the case that shows why. A Form is a named type, but it is not text, not a document, and not media: the evidence vocabulary has no member for it, so `unknown` is the honest answer rather than a wrong one. The other silence is a record whose type the provider never sent. Both mean "Alfred cannot say what this is".

5. **A page anchor comes only from proven page structure, and it REPLACES the prose locator.** `chunks.metadata.page` is written from page structure the extractor emitted (ADR-0091), and the chunker bounds a chunk to one page. A hit that carries a page therefore IS a page of a document, and the document adapter mints `{ kind: "page", page }`. The card previously stated the same fact as a citation locator string, `page 3`, which a consumer could read only by a parse of the label beside it. The locator is gone. One fact gets one spelling, and the structured carrier wins because the contract minted it for this.

6. **A page anchor carries no `confidence`.** The page is proven rather than estimated. A confidence would invite a reader to discount a fact the extractor established.

7. **A media file becomes a real card with an honest note, not a dropped card.** The Drive manifest declares `text`, `document`, `image`, `audio`, `video` and `unknown`. The list is wide because a Drive is wide, and Drive's own index matches a picture and a film as readily as a memo. A card for one of those states a true thing: the file exists, under this name, changed at this instant. A narrow declaration would make the boundary drop those cards, and the read would then report "no such file" for a file the user owns.

8. **The Drive "no text" note splits into three facts.** One sentence covered three causes that differ in who must change for the answer to change. `noTextPathReason` now separates them: a Form, a Site, a Script or a Drawing is a type Drive itself cannot export as text; a PDF, a picture, a recording or a film is a type Alfred has no lane to extract; and a file with no reported MIME type is one Alfred cannot classify at all. The second is the one a later slice makes false. Every branch opens with the same clause, "this file matched the search", because a Drive card with no text is still evidence.

    A folder and a shortcut get no branch of their own. Neither can reach a card: the query excludes both MIME types, `readDrive` filters them a second time, and the expansion returns early on a `none` text path. A fourth branch for them would be a sentence no reader can ever see. A container that arrives anyway takes the Google-native branch, which states a true thing about a folder.

9. **A Drive card gets an expansion handle only where a later read can add text.** This rule is unchanged from ADR-0104 sub-decision 6, and the wider modality list does not relax it. An image card carries no handle, so no read ever pays a provider call to learn the same fact again.

10. **A visual anchor and an extraction confidence stay contract-only.** `EVIDENCE_ANCHOR_KINDS` admits `visual`, and `evidenceAnchorSchema` admits a region and a confidence. Nothing proves a region today, so nothing mints one. The contract holds the vocabulary for the extraction slice that follows; this slice writes no value it cannot prove.

11. **The document adapter reads its corpus row, never a MIME type.** A corpus row carries no MIME type, because the ingest lane already turned the bytes into text. The modality of the evidence is the modality of that text and not of the file behind it. So `documentMediaKind` reads a proven page first, then `isFileDocumentSource(hit.source)` for a file row against a message row, and answers `text` otherwise. `isFileDocumentSource` lives in `@alfred/contracts` beside `DOCUMENT_SOURCES`, so "a file row against a message row" is stated one time rather than re-derived from the `gmail_attachment` slug at each reader.

**Amends ADR-0101** (Context Search is a read-boundary module): `mediaKinds` leaves the catalog-reserved set, exactly as `expansionKinds` did with #1077, and sub-decision 14 now names three required declarations. **Extends ADR-0091** (document extraction), which supplies the proven page. **Relates to ADR-0104** (Drive is a live source), whose adapter this changes most. **Slice #429 of epic #422.**

## Alternatives

- **(a) Keep `mediaKinds` optional and catalog-reserved.** Rejected. The boundary now branches on the field, and an optional field that a branch reads makes silence the widest declaration. A source that forgot the line would admit every modality, which is the opposite of what the declaration buys.
- **(b) Put the modality check in `evidenceCardSchema`.** Rejected. The schema validates a card against itself. The declared modality belongs to the source, which the card does not carry, so the check needs both values and only the boundary holds both.
- **(c) Check the collect phase alone.** Rejected. The expansion phase mints a replacement card from a provider read, and that card enters the pack at the rank position of the card it replaced. An unchecked refresh is a back door.
- **(d) Drop a card whose modality Alfred cannot extract.** Rejected. It reports absence for a record that exists, and ADR-0101 sub-decision 4 forbids a silent absence. A named file with an honest note is evidence the user can act on.
- **(e) Keep `page N` in the citation locator beside the anchor.** Rejected. Two spellings of one fact drift, and the packer already renders the anchor on its own line.
- **(f) Mint a `visual` anchor for an image card.** Rejected. No extractor reports a region, so any region would be an invention. The same argument closes an invented `confidence`.
- **(g) Download the bytes and run OCR in this slice.** Rejected. The issue asks for media support without full extraction on day one. An extraction lane is a cost, a failure surface and a provider budget of its own, and it needs its own decision.
- **(h) Derive a corpus card's modality from a stored MIME type.** Rejected. The corpus stores no MIME type, and a lookup back to the provider record would put a second read on a local path for a field the evidence does not depend on.
- **(i) Hold a card to a modality allowlist that the boundary owns.** Rejected. It is the name switch ADR-0101 exists to remove. The declaration belongs to the source, and the boundary reads it.

## Residual risk

- **No test proves the new behavior, per the repo rule.** The compiler carries the manifest change for every literal manifest, and `retrievalSourceManifestSchema` carries it at boot for every other. The existing suites (65 context-search assertions, 2019 in `@alfred/assistant`) still pass, so the change breaks nothing they already assert. What nothing proves is the new path itself: no test rejects a card whose modality its source did not declare, and no test reads a Drive image card's note. Both would be feature tests.
- **A required field on a parsed manifest fails at BOOT, not at compile time.** A literal manifest fails the typecheck. Any manifest built at runtime — an MCP source that describes itself from a server response is the case that arrives next — throws from `defineContextSource` instead. That is the intended failure, and it is louder than a dark source, but it is a boot failure and not a build failure.
- **The declaration is one-directional.** The boundary rejects a card whose modality the manifest omits. Nothing detects the reverse: a source that declares `video` and never returns one keeps a declaration that is simply untrue. A catalog reader that prices a source by what it claims to hold would read that claim at face value.
- **`mediaKindForMimeType` has a list half, and a list goes stale.** The prefix half cannot: a new image format reads as `image` with no edit. The `application/*` half is a list, so a new office format reads as `unknown` until somebody adds the row. `unknown` is the honest answer for it, and the Drive manifest declares `unknown`, so a missing row degrades the note and never drops the card.
- **A Drive Drawing takes the provider branch, not the media branch.** A Drawing is an `image` AND a Google-native type with no text export. The note states the provider limit, because that limit holds whatever Alfred builds later. The card's `mediaKind` still says `image`, so the two halves of the card describe the same file from two angles.
- **A media card carries NO expansion handle, and the issue's wording asks for one.** The acceptance criterion reads "Raw bytes/full media are not placed in model context by default; cards carry expansion handles." The first half holds. The second does not, for an image, an audio file or a video: ADR-0104 sub-decision 6 gives a handle only where a later read can add text, and no reader can add text to a picture today. A handle there would be a handle that always fails, and it would buy one `getFile` call per surviving card to learn a fact the card already states. The handle arrives with the extraction lane that can honor it. This is a deliberate deviation, not an oversight.
- **The notes are prose that a model reads, and nothing measures them.** The split from one sentence into three is argued from what a reader must decide, not from a measurement. The retrieval eval (#430) is what would tell whether the model treats a PDF card differently from a Form card.
