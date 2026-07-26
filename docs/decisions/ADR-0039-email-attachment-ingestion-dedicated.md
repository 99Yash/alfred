# ADR-0039 — Email attachment ingestion: dedicated `attachments` family, page-bounded typed chunks, separate extraction queue


**Decision.** Attachments on ingested emails become first-class entities with their own ingestion path, distinct from the existing `documents`/`chunks` text flow. Three pieces:

1. **Schema family** — new `attachments` and `attachment_pages` tables; `chunks` gains `attachment_page_id` (xor with `document_id`) plus segment-typing columns.
2. **Extraction stack** — Anthropic Claude (Haiku 4.5 default) takes PDF/image input, returns a prompt-shaped typed-segment JSON. Same call shape for standalone images. Metered as `attribution.kind = 'doc_extraction'`.
3. **Dedicated `doc-extraction-runs` BullMQ queue** — isolated from `ingestion-runs` so Anthropic latency and dollar-cost don't bleed into Gmail polling.

**Why this is its own ADR.** ADR-0010 chose one `documents` + `chunks` schema "source-tagged" and explicitly punted attachments. ADR-0021 (embedding) and ADR-0037 (realtime ingestion) likewise assumed flat text bodies. Attachments break three of those assumptions at once — they have page structure, they carry typed elements (tables, figures), and their extraction has a per-call dollar cost. Trying to retrofit `documents` would either (a) add nullable page-shaped columns that don't apply to emails, or (b) hide the typing inside `metadata` jsonb where retrieval can't filter on it. A sibling table is the honest shape.

**Schema (sketch — full DDL lands in the migration):**

```
attachments
  id, user_id, parent_document_id (→ documents.id),
  source ('gmail'), source_part_id, mime_type, filename, byte_size, sha256,
  page_count nullable,
  binary_uri (Railway bucket key — gmail attachments live forever in our bucket),
  extraction_status ('pending' | 'extracting' | 'extracted' | 'failed' | 'skipped'),
  extraction_model, extracted_at, last_error,
  skipped_reason ('mime_unsupported' | 'size_exceeded' | null),
  truncated_at_page nullable,
  lifecycle_dates

attachment_pages
  id, attachment_id (→ attachments.id, cascade),
  page_number,
  extracted_text (concatenated page text; plaintext at rest per ADR-0038),
  asset_inventory jsonb {
    tableCount, figureCount, footnoteCount,
    hasImages, hasLinks, headings: string[]
  },
  layout_hint nullable,
  unique(attachment_id, page_number)

chunks  (gains columns; existing rows unaffected)
  attachment_page_id nullable (→ attachment_pages.id, cascade),
  CHECK ((document_id IS NULL) <> (attachment_page_id IS NULL)),  -- xor
  kind ('text' | 'table' | 'figure_caption' | 'heading' | 'footnote' | 'list'),
  parent_section text nullable,
  bbox jsonb nullable
```

`chunks` stays the single source of truth for embedded vectors — retrieval queries one table and decides at render time whether the citation points back to a `documents` row or an `attachment_pages` row. No polymorphic join, no UNION across tables.

**Chunking semantics (extends `packages/ingestion/src/chunker.ts`):**

- **Page is the citation/grouping anchor.** Chunks never cross page boundaries.
- **Typed segments within a page.** Each chunk's `kind` matches an extractor-emitted segment type.
- **Tables never split mid-row.** A table is its own chunk regardless of size; if it exceeds `maxTokens`, it lands with `metadata.truncated = true` and the boss agent sees a flag rather than a corrupted table.
- **Headings cascade.** A `heading` chunk becomes a standalone chunk AND populates `parent_section` on every subsequent non-heading chunk on the same page. A retrieved chunk knows "I'm under §3.2 Termination" without re-reading neighbors.
- **No cross-page overlap at v1.** Ideas-that-straddle-a-page-break are split. Same trade the email chunker has at paragraph boundaries; revisit if observed retrieval misses are real.

**Extraction stack (Claude with PDF/image input):**

- Default: **Haiku 4.5** at ~$0.005–0.02/page. PDF goes in via `document` content type; standalone images via `image` (single page).
- **Sonnet escalation rule:** if a page's `assetInventory.figureCount > 0` AND any figure has no caption returned by Haiku, re-extract that page only with Sonnet. Bounded cost increase, sharply better figure descriptions when they matter.
- **Schema control.** The system prompt specifies the exact JSON shape — `{ pages: [{ pageNumber, segments: [{ kind, text, bbox?, parentSection? }], assetInventory }] }`. No vendor schema-translation layer.
- **Vendor alignment.** Anthropic is already a paid dependency; no new SDK, contract, or credential surface.

**Dedicated queue: `doc-extraction-runs`.**

Co-mingling extraction with `ingestion-runs` would let one Anthropic outage backlog Gmail polling, and a burst of attachments would starve `gmail.poll_recent` of worker slots. The queues have different latency, cost, retry, and concurrency profiles:

| Property | `ingestion-runs` | `doc-extraction-runs` |
|---|---|---|
| Per-job latency | sub-second | multi-second per page |
| Per-job dollar cost | ~$0 | real money |
| Bottleneck | Gmail rate limits | Anthropic rate limits |
| Concurrency default | 2 | 5 |
| Retry shape | 5 attempts, 5s backoff | 3 attempts, 30s backoff |

Jobs on the new queue:

- `attachment.extract { attachmentId }` — primary unit. Pulls binary from the Railway bucket, runs the Claude call, persists pages + chunks, flips `extraction_status`.
- `doc-extraction.sweep` — hourly repeatable. Picks up `attachments` rows stuck in `pending` for > 1hr or `failed` with < 3 attempts. Mirrors `gmail.embed_sweep`'s shape.

Terminal failure flips `extraction_status='failed'` with `last_error` populated; no separate dead-letter table. The row IS the dead letter, queryable from the UI.

**Realtime pipeline after this ADR:**

```
gmail.poll_recent (existing — ingestion-runs queue)
  → persistMessage
      ├── inserts documents row
      └── inserts attachments rows for each MIME part with attachmentId
          (subject to MIME allowlist + size cap — see gates below)
  → fan in parallel:
      ├── enqueueTriageRuns           (existing — body only, no attachment dep)
      ├── embedRealtimeInserts        (existing — best-effort)
      └── enqueueAttachmentExtracts   (NEW — pushes attachment.extract jobs
                                       onto doc-extraction-runs)
```

Triage stays on the body. Per Q9 of the design: the six triage categories are body-shape signals; coupling triage to extraction latency would walk back ADR-0037's realtime gains for marginal accuracy. Edge case accepted: "see attached" emails with empty bodies may mis-classify as `fyi` when the attachment makes them `action_needed`. The user can re-label; the next message in the thread gets a fresh classification.

**Cost gates (four, in pipeline order):**

1. **MIME allowlist at enqueue.** `application/pdf`, `image/png`, `image/jpeg`, `image/heic`, `image/webp`. Else → row created with `extraction_status='skipped'`, `skipped_reason='mime_unsupported'`. Row exists so the UI can show "we have a `.zip` here we didn't process" rather than the attachment invisibly vanishing.
2. **20 MB size cap at enqueue.** Else → `skipped_reason='size_exceeded'`. Real receipts/contracts/passport scans are < 5 MB; > 20 MB is almost always video, scans at absurd DPI, or someone's portfolio.
3. **50-page cap at extraction time.** Read PDF header (cheap, no Claude call) for `pageCount`; if > 50, extract pages 1–50 and set `attachments.truncated_at_page = 50`. First 50 pages are almost always the substantive content; back half is appendices and signature blocks. A future tool can request a deeper extract on demand.
4. **$5/day per-user soft cap.** Worker `beforeProcess` queries `SUM(cost_usd) WHERE kind='doc_extraction' AND user_id = ? AND created_at::date = current_date`. If over, `job.moveToDelayed(nextMidnight())`. Deferred, not lost. Env-configurable as `ALFRED_DOC_EXTRACTION_DAILY_BUDGET_USD`; promotes to `user_action_policies` only when a second user appears.

Explicitly rejected: filename heuristics (`/terms|legal|tos/i` → skip) — too brittle; `Terms_of_Sale_for_HouseClosing.pdf` is exactly the kind of doc to extract. Per-MIME budget splits — premature. Adaptive throttling on Anthropic rate limits — BullMQ concurrency 5 + 30s retry backoff handles it.

**Lifecycle (per Q7 of the design):**

- **Binaries land in the Railway bucket on ingest** and stay forever. ADR-0038 dropped `documents.raw` because Gmail is durable; attachments invert that — Gmail's attachment retention is bounded by message lifetime, so to keep "show me my passport" working after inbox-zero, we hold the bytes ourselves.
- **Email deletion in Gmail does not cascade.** Inbox-cleanup ≠ memory revocation. A separate explicit "forget this" UI lands later for real deletion intent.
- **Re-extraction with a future better model is possible** for every attachment because binaries are durable. The extraction call is the only variable.

**Retrieval interaction.**

A `chunks` row from an attachment renders citations as "page N of {filename}" by joining `chunks → attachment_pages → attachments`. The `kind` column lets the boss agent answer "what tables are in this PDF" without re-reading the document — `WHERE attachment_id = ? AND kind = 'table'` over `chunks`. The `asset_inventory` jsonb on `attachment_pages` supports the higher-level query "which page has the financial breakdown" without joining chunks at all.

**Trade-offs being accepted:**

- **Vendor cost on the realtime path.** Every email with a PDF kicks off a paid Claude call. Four-gate shield bounds the worst case at ~$5/day; observed steady-state should be < $0.50/day at single-user volume.
- **Two-table read on every attachment citation.** Retrieval pays one extra join (`chunks → attachment_pages → attachments`) compared to email chunks. Negligible at our index size.
- **No category filter** (deferred per the 2026-05-22 grilling, see Open/deferred). Promo/social/forum emails go through the full pipeline including extraction. Gates 2–4 bound the cost; revisit if observed extraction spend on those categories is materially non-zero.
- **Cross-page idea splits.** No overlap across page boundaries. Same trade as the email chunker at paragraph boundaries; not solved at v1.
- **Claude vendor exposure on attachment content.** Same posture as embeddings via Voyage and triage via the cheap-tier LLM — contractual, not cryptographic, per ADR-0038.

**Alternatives.**

- **Single `documents` table with nullable page-shape columns** (rejected — pollutes the email-only happy path; typing hidden in `metadata` jsonb where retrieval can't filter).
- **Polymorphic `chunks.owner_kind + owner_id`** (rejected — every read path acquires a coalesce; no real win at single-user scale over the xor approach).
- **Inline attachment text appended to `documents.content`** (rejected — burns the page boundary at ingest, kills citation precision, churns `content_hash` on re-extraction).
- **Mistral OCR / LlamaParse / Reducto for extraction** (rejected — strong vendors but adds a new contract/SDK/credential surface for marginal cost savings vs the existing Anthropic relationship; revisit if Anthropic extraction quality proves insufficient).
- **Native pdf-parse + per-image vision** (rejected — collapses tables to wall-of-text; quality on the use cases we care about is bad).
- **Cascade-delete attachments on Gmail message deletion** (rejected — inbox hygiene ≠ memory revocation; "forget this" is a distinct explicit UX).
- **MIME extension to include `.docx`** (deferred — PDF covers 95% of business docs; add when business-doc use cases prove real).

**Triggers to revisit.**

- **Multi-user.** $5/day env-var budget moves to a per-user column in `user_action_policies`.
- **Sustained extraction spend on promo/social/forum mail.** Promotes the deferred category filter from Open/deferred into a real ADR.
- **Anthropic extraction quality complaints.** Comparative eval against Mistral OCR / LlamaParse; the extraction module is one file, swapping vendors is bounded.
- **A real "summarize this PDF" feature for > 50-page docs.** Drops the 50-page cap or makes it user-overridable per attachment.

**Implementation order (when this milestone opens):**

1. Drizzle migration — new tables + `chunks` column additions + xor CHECK constraint.
2. Railway bucket provisioned; binary upload helper in `packages/integrations/src/google/gmail.ts` (re-uses existing OAuth client).
3. Extraction module in `packages/ingestion/src/extract-document.ts` — Claude call with the typed-segment prompt, returns the canonical JSON; handles Sonnet escalation on caption-less figures.
4. New BullMQ queue in `packages/api/src/modules/integrations/queue.ts` (or extract into its own module if `queue.ts` is getting fat).
5. `enqueueAttachmentExtracts` helper called from the existing realtime path next to `enqueueTriageRuns` + `embedRealtimeInserts`.
6. Four gates wired in (MIME + size at enqueue; page-count + budget at worker).
7. Smoke script: `pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-attachments.ts` against a real Gmail with a known PDF.
