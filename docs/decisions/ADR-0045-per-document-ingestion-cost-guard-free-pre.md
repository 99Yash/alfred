# ADR-0045 — Per-document ingestion cost guard: free pre-flight estimate, reject-on-exceed, passive row status


**Decision.** Every document the embedding pipeline touches gets a **free pre-flight cost estimate before any paid call**, and is rejected (not partially run, not retried into the ground) if the estimate exceeds a per-document budget. Two paths, one principle ("estimate, then approve or reject"):

1. **Embedding (new).** In `embedDocument()`, after chunking and before `embedMany()`, sum the chunk `tokenCount`s (already computed locally by the chunker — zero marginal cost), multiply by the Voyage input rate from `model_prices`, and compare to `ALFRED_EMBEDDING_PER_DOC_BUDGET_USD` (default **$1.00**). Over budget → skip the Voyage call, flip the document to `embedding_status='budget_exceeded'`, and stop. The estimate is exact for embedding because Voyage bills per input token and we know the token count before the call.
2. **Extraction (designed in ADR-0039, never shipped; superseded by ADR-0091).** Correction, 2026-08-19: this item originally described ADR-0039's four-gate shield as shipped and standing. It was never built — no `attachments` tables, no `doc-extraction-runs` queue, no gates exist. ADR-0091 supersedes the design: its deterministic local extractor removes the per-page model cost the shield was sized for, so the dollar-cost gates lose their object on the PDF path; byte caps survive as input hygiene at each door. This ADR's embedding-path guard (item 1) is unaffected and stands as written.

**Why this is its own ADR.** ADR-0015 metered every billable call but logs cost *post-hoc* — it never refuses one. ADR-0021 sized the embedding corpus at $3–9 *lifetime* and reasonably treated embedding as too cheap to gate. ADR-0039 designed a cost shield for the attachment-extraction queue, but never shipped it. The gap this ADR closes: the **embedding path has no pre-flight refusal at all**, and `documents` has **no status column**, so a skipped or failed document is invisible. A reader will ask "embedding is nearly free — why gate it, and where does a rejected doc show up?"; this answers both.

**The per-doc embedding budget is a pathological-input ceiling, not an active throttle.** At `voyage-3.5` = **$0.06 / 1M input tokens**, the $1.00 cap is ~**16.7M tokens ≈ 67 MB of text in one document**. No real email, PDF, or note approaches it; the guard exists to stop a runaway input (a malformed export, a giant log dump, a base64 blob mistaken for prose) from silently embedding into a five-figure-chunk balloon. It rides for free on a token count the chunker already produces, so the cost of having it is one comparison. ADR-0021's $3–9 *lifetime* corpus estimate remains the accepted aggregate spend — **there is no lifetime cap enforced**; this ADR adds only the per-document ceiling.

**Schema (documents gains status; full DDL in migration).**

```
documents  (gains columns; existing rows default to 'pending' then backfill to 'embedded')
  embedding_status ('pending' | 'embedded' | 'budget_exceeded' | 'failed')  default 'pending'
  skipped_reason   ('budget_exceeded' | null)
  last_error       text nullable        -- populated on 'failed', mirrors ADR-0039's attachments.last_error
  estimated_embed_tokens integer nullable  -- the pre-flight number, for audit + UI
```

Mirrors ADR-0039's `attachments.extraction_status` shape deliberately, so the two ingestion families surface the same way. `chunks.embedding` stays nullable as today; the document-level status is the unit a human or agent reasons about.

**Surfacing — passive row + agent-visible flag, no notification.**

- **Passive row status.** `embedding_status` / `skipped_reason` live on the row, queryable by a future documents/library UI. The row IS the dead letter (same philosophy as ADR-0039's `extraction_status='failed'`); no separate table.
- **Agent-visible flag.** Retrieval surfaces a budget-skipped document to the boss agent so it can say "I have a document I haven't indexed (too large to embed)" inline, rather than the doc vanishing from recall with no explanation — the embedding-path twin of ADR-0039's `truncated_at_page` flag.
- **No active notification.** Deliberately excluded. A `notify()` kind for budget events is not built; at single-user scale a per-doc embedding rejection is a near-impossible event, and the passive status + agent flag cover the realistic case (the user asks about a doc, the agent explains it wasn't indexed). Revisit only if a second user or a routinely-firing cap makes silent skips a real support burden.

**Recovery.** A `budget_exceeded` document is not embedded but is not lost — the row and content persist. Raising `ALFRED_EMBEDDING_PER_DOC_BUDGET_USD` and re-running the embed sweep (`gmail.embed_sweep`, ADR-0037) re-evaluates it. No automatic retry: unlike a transient `failed`, a budget rejection is deterministic and will fail identically until the budget or the document changes, so the embed sweep skips `budget_exceeded` rows and only retries `failed` ones.

**Trade-offs accepted.**

- **A `budget_exceeded` doc is silently un-searchable** until a human raises the cap or the agent surfaces it on demand. Accepted: the alternative (notification spam for an event that essentially never fires) is worse.
- **The estimate trusts the chunker's char-based token count** (4 chars/token), which can drift from Voyage's real tokenizer. Accepted: the cap is a 67 MB sanity ceiling, not a fine-grained throttle, so a ±20% tokenizer error changes nothing material.

**Alternatives.**

- (a) **No embedding gate (status quo / ADR-0021's stance).** Rejected here only at the margin — embedding is genuinely cheap, but a free pre-flight guard against a pathological input is one comparison, and the user wants an explicit, documented ceiling.
- (b) **Lifetime or daily embedding budget.** Rejected — ADR-0021's $3–9 lifetime is acceptable spend; a daily/lifetime embedding cap is the "per-MIME budget split" ADR-0039 already rejected as premature. The per-doc ceiling is the proportionate guard.
- (c) **Per-doc dollar cap on extraction too.** Redundant — ADR-0039's 50-page cap already bounds one attachment at ~$1; a second dollar check on the same path adds nothing.
- (d) **Active `notify()` on every budget event.** Rejected — see Surfacing; near-zero fire rate doesn't justify a new notification kind.

**Open.**

- Whether the documents/library UI that renders `embedding_status` is built in this milestone or deferred — the schema lands now regardless so the status is recorded from day one.
- The exact env-var default ($1.00) — trivially tunable; promotes to `user_action_policies` only when a second user appears, same as ADR-0039's $5/day cap.

**Cross-ref.** Extends ADR-0015 (metering) from log-only to refuse-before-call on the embedding path; complements ADR-0039 (the extraction-path cost shield) with the matching embedding-path guard and a shared row-status surface; the budget number is a sibling of ADR-0039's `ALFRED_DOC_EXTRACTION_DAILY_BUDGET_USD`. Recovery rides ADR-0037's embed sweep.
