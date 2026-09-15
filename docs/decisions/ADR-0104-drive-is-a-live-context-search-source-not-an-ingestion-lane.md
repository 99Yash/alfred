# ADR-0104 — Drive is a live Context Search source, not an ingestion lane

**Status.** Accepted. Issue #1078, epic #422. `createDriveContextSource` is registered at the composition root with the three local sources.

## Decision

Google Drive and Google Docs reach Context Search as ONE live source. The source keeps no local copy. It answers each read with a call to Drive. Its manifest declares `kind: "native"`, `integration: "drive"`, `freshness: live`, `authority: high`, and `cost: remote`.

Issue #1078 gave two shapes and asked this slice to pick one. The rejected shape is an ingestion lane: a job copies each Drive file into the `documents` corpus, splits it into chunks, and embeds each chunk. The existing `documents` source then answers from that copy.

### What each shape costs on the read path

| Question                                     | Live source                                                   | Ingestion lane                                          |
| -------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| Cost of one search                           | One `files.list` call, plus at most three text reads          | One local vector read                                   |
| Latency of one search                        | About 1500 ms, declared as `typicalLatencyMs`                 | A few milliseconds                                      |
| Cost of one file change                      | None                                                          | One extraction and one embedding                        |
| Full-text index                              | The index Drive already runs                                  | A second index that Alfred builds and keeps             |
| A file that the owner edits between two reads| The read returns the text of this moment                      | The read returns the copy until the lane runs again     |
| A share that the owner revokes               | The next read returns nothing, because the provider ACL applies | The copy stays until a separate revocation lane deletes it |
| New failure surface                          | One provider call, which fails loudly and is reported         | One change feed, which can stop and report nothing       |

The live source costs more for each read. It costs nothing for each file change, and it is correct on every row that states a fact about the user's data.

Four reasons decide the choice:

1. **Drive already runs the index.** `files.list?q=fullText contains` searches the full text of the same files. An ingestion lane builds a second index over data that has one, and pays an embedding for each file to do it.
2. **A document changes; a mail message does not.** A sender cannot edit a message after the send, so `freshness: "ingested"` is honest for mail. An owner edits a document at any time, so the same word on a document copy is misleading.
3. **A revoked share must stop being evidence at once.** A live read inherits the provider ACL on every call, so revocation needs no Alfred code. An ingested copy outlives the grant until a revocation lane finds it.
4. **A change feed is operational surface.** Alfred lost a Gmail push channel one time, and no alarm reported the loss. An ingestion lane adds one more feed of that kind; the live source adds none.

## Sub-decisions

1. **Drive and Docs are ONE source, because a Google Doc is a Drive file.** The same `files` endpoint finds it, and the same `export` call reads it as text. Two adapters would put one file under two source ids, and the ranker would then count that file twice. The `docs` integration keeps the structural surface — headings and the shape of a document — and stays an action and tool concern.

2. **`maxSourceCost` is a caller budget over DECLARED cost, and the ladder lives with the selection policy.** `contextSearchRequestSchema` gains `maxSourceCost`, which defaults to `remote`. It is the sibling of `expand`: `expand` prices the second phase, and this field prices the first. The field was necessary because a live source calls a provider on the collect path, where no cap priced anything — the expansion cap bounds only the round trips that follow the rank. `sourceCostBudgetSchema` derives from `sourceCostClassSchema` and excludes `unknown`, because a budget is a statement and "I do not know what I will pay" is not one. The RANK between the classes lives in `context-search/manifest.ts`, beside `selectContextSources`, and not in `@alfred/contracts`. This is the split that ADR-0101 sub-decision 16 draws for the ranker weights: contracts state what a manifest MEANS, and the reader that spends the money decides what to do about it. An undeclared cost scores the top rung, so silence never buys a source past a budget. An excluded source reports the new `over-budget` reason and is never dropped in silence. `searchContextInput` omits the field beside `userId` and `expand`, because the model cannot price a provider call that the server pays for.

3. **A reader may declare its own skip.** `ContextSourceResult` gains an optional `skipped: SourceExclusionReason`. `selectContextSources` prices and screens a source from its manifest, which is parsed once at boot and is identical for every read. Whether this user has connected Drive is not that kind of fact: it is per-user and per-read, and no boot-time declaration can carry it. The Drive reader catches `GoogleCredentialSelectionError` alone and returns `{ evidence: [], skipped: "not-connected" }`. The boundary honors the skip only when the source returned no evidence and no reader failed. Without this field the fact must wear one of two wrong words, and ADR-0101 sub-decision 4 forbids both: `empty` claims that Alfred asked and found nothing, which lets a consumer close a loop on evidence that nobody sought; `error` claims a failure, which puts a routine disconnected account beside a real outage in the packer's notes.

4. **ADR-0101 sub-decision 18 is AMENDED. The expansion phase skips a card that is already READ, not a card that is merely `live`.** The old guard passed over any card whose `time.freshness` was `live`, because a live card needed no refresh. That reading holds only while every live card holds its record. A live source can find a record and still not read it: this Drive search matches up to five files and reads the text of three. For the other two cards the phase is not a refresh of stale content; it is the first read of the content. The guard is now `isAlreadyRead(card)`, which requires `live` AND a `snippet`. `live` says WHEN Alfred made the card, and a snippet says whether the card holds the record. Both halves are load-bearing: a snippet alone also describes an ingested card, which is the card the phase exists to refresh. Nothing changes for the three existing sources, because none of them mints a live card in the first phase. `expansionRoutes` also takes the request now, so a source that the caller cannot afford routes nothing either; a caller that declined a provider call on the collect path has not agreed to five of them here.

5. **The source declares `keyword_search` and not `semantic_search`.** `fullText contains` matches whole literal words. The source therefore answers "the Q3 budget memo" well and "how did the reorganization go" poorly. The weaker declaration is a fact, not modesty: it is what lets the boundary and the reader price an empty answer correctly instead of reading it as an absent document. The query builder is deterministic and offline. It lowercases the query, drops stop words and terms below three characters, keeps the four longest terms, and ANDs them with `trashed = false`. Two traces of one read therefore compare. A query that leaves no usable term asks Drive nothing, because `trashed = false` alone returns the most recent files whatever the question was.

6. **The search reads the text of the three strongest matches inline.** The expansion phase cannot do this job. That phase runs AFTER the rank, and a card with no text carries no `score` and no snippet, so the `limit` truncates it before the phase plans anything. An inline read is what puts real evidence in front of the ranker. The reads run in parallel and settle one at a time, so one unreadable file costs the others nothing. Every match that the read could not afford carries a `drive_file` handle, so the phase reaches it when the card survives the rank anyway. A card gets a handle only where a later read could add something: the file has a text path, and this card does not already hold the text.

7. **The card carries no `score`.** Drive returns no relevance number. An invented number would be the self-reported score that ADR-0101 closes with a registration rule. The ranker drops the feature instead. For the same reason the page is five files, far below `CONTEXT_SEARCH_MAX_LIMIT`: a wide page feeds the cross-source ranker many cards that it cannot tell apart.

8. **One attempt per Drive call, and no retry.** `integrations({ userId, retry: "none" })`. The manifest declares a latency, and a caller prices this source against that number, so a retry envelope would multiply the worst case behind the declaration on a path that a chat turn waits for. A transient provider failure becomes a reported `error`, the boundary degrades to the other sources, and the next read tries again.

**Extends ADR-0101** (Context Search is a read-boundary module) and **amends its sub-decision 18**. **Depends on ADR-0093** (integration registry), which supplies the `drive` slug, its display name, and its host. **Slice #1078 of epic #422.**

## Alternatives

- **(a) Ingest Drive into the corpus.** Rejected, for the four reasons above. The decisive one is correctness rather than cost: a copy cannot state the text of a document that changed, and it cannot forget a share that the owner revoked.
- **(b) A hybrid: ingest the file list, read the text live.** Rejected. It keeps the change feed, which is the operational cost of shape (a), and it still pays a provider call for the text, which is the read cost of this shape. It buys only the ability to rank a file that Alfred has not read.
- **(c) One source for Drive and a second for Docs.** Rejected. A Google Doc IS a Drive file, so both sources would find the same file, and the ranker would place one file twice under two ids.
- **(d) Overload `expand: false` to mean "no provider call at all".** Rejected. `expand` prices the second phase. A caller that wants the local evidence and the Drive search, or the Drive search and no expansion, could not say so. Two budgets over two phases say what one flag cannot.
- **(e) Put the cost ladder in `@alfred/contracts`.** Rejected. What `remote` MEANS is a fact about a source and belongs in contracts. How much `remote` is worth against `metered` is a spending decision of the reader that pays. ADR-0101 sub-decision 16 already draws that line for the ranker weights.
- **(f) Report a disconnected account as `empty` or as `error`.** Rejected. Both break the honesty rule of ADR-0101 sub-decision 4, in opposite directions. See sub-decision 3.
- **(g) Keep the old `live` guard in the expansion phase and read every match inline.** Rejected. Five exports for each Context Search read is a cost that the caller cannot decline, and the two extra files are usually the weakest matches. The handle defers that cost to the cards that survive the rank.
- **(h) Ask a model to write the Drive query.** Rejected. It adds a model call to a read that the chat turn waits for, and it makes the same question produce different queries, so two traces no longer compare. The narrow keyword declaration is the honest statement of what this source does.

## Residual risk

- **The three provider behaviors that issue #1078 names are proved by nothing.** The issue asks for tests over a connected account, a disconnected account, and a file that the provider cannot return as text. The repository directive forbids tests for a feature, and the directive wins. The compiler carries the shapes, and the boot-time manifest guards carry the `expand`-and-`expansionKinds` pairing. The three behaviors above carry no proof.
- **No production read has ever called Drive through this adapter.** Nothing has met Drive's real latency, its rate limit, or a file that it refuses to export. The declared `typicalLatencyMs` of 1500 is an estimate, and a caller budget prices this source against it.
- **The stop-word list is English and hand-written.** It is not a stemmer and it is not language detection. A question in another language keeps every term, and a term that this list misses narrows the AND to nothing. The failure is a quiet empty answer from a source that declared `keyword_search`, which is the declared weakness rather than a defect.
- **`skipped` is a source-owned word, and nothing audits it.** A reader may return any `SourceExclusionReason`, including one that the selection phase owns, such as `over-budget`. The boundary honors the first one that a reader reports. A wrong reason is visible in the pack, so the failure is loud, but the contract does not narrow the set.
- **The amended expansion guard now admits a class of card that never existed before.** Every live card with only a note is a candidate for the phase, so the `CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS` cap and the shared-`(kind, ref)` fold carry more traffic than they did. The cap is unchanged at five, and the phase deadline is unchanged.
- **This source makes the `unavailable` and cost branches production paths for the first time.** ADR-0101 recorded that its selection branches had run only under test. `over-budget` joins them: no production caller lowers `maxSourceCost` today, because the default is `remote` and the model-facing tool omits the field.
