# ADR-0019 — Memory correction loop UX

**Decision.**

**Input channels (v1):** in-app cards + in-chat extraction. Email-reply parsing deferred (brittle; structured emails with deep links to in-app are cleaner). Slack/iMessage corrections fold into chat-extraction once those transports connect.

**Lifecycle:** every `user_facts` row has `status ∈ {proposed, confirmed, rejected, edited, superseded}`. Confidence-tiered auto-confirm: facts with `confidence > 0.85` auto-confirm with a soft notification ("alfred learned: X" with undo); facts below stay `proposed` and require explicit accept. Edits create supersession chains via `supersedes_id`; full history retained. Rejections are first-class — a `rejected_inferences` table tracks pattern signatures so the extraction sub-agent doesn't re-propose them.

**Extraction triggers (all three):**

- **End-of-conversation** — after each chat thread closes, run a `memory_extraction` sub-agent over the transcript + current `user_facts` to propose deltas. Cheap-tier model.
- **Background cron (daily)** — bulk extraction over recent ingested integration data (sent emails, accepted invites, resolved tickets). The workhorse — most facts come from here.
- **Triggered (event-based)** — high-signal events (new contact added, first email exchange with new sender, new project signal) emit a `propose_facts` job.

**UX shape.**

- **Memory page** in the app: tabs for facts / preferences / style profiles. Cards show key, value, confidence, source link, timestamp, [✓ confirm] [✗ reject] [✎ edit]. Replicache-synced; filterable by status, source, recency.
- **Inline corrections in chat**: when alfred cites a fact ("I'll loop in Alice (your manager)"), it's a soft hyperlink to inspect/correct without breaking flow.
- **Auto-confirm notification**: non-modal toast with undo affordance.
- **No mid-task interrogation** — corrections are always async and batched, never interrupt a task.

**Extraction sub-agent invariants** (prompt-engineering pass — flagged, not designed here):

- Conservative-by-default; high confidence threshold for emitting.
- Awareness of `rejected_inferences` to avoid re-proposal.
- Zod-enforced output schema `(key, value, confidence, source_id, valid_from)`.
- Provenance discipline: every fact cites a specific `message_id` or `tool_call_id`; no hallucinated sources.

**Why confidence-tiered auto-confirm vs always-explicit-accept.**

- Always-explicit floods the user with "is this right?" cards for obvious facts (someone's email signature literally says "Alice, Engineering Manager") — friction without value.
- Always-auto erodes trust; user wants the gate for ambiguous inferences.
- Tiered captures both: friction for ambiguous, frictionless for obvious, undo as the safety net.

**Why email-reply parsing deferred.**

- Free-form reply parsing is brittle and ambiguity-prone.
- The "review" use case is better served by structured emails with a "review in app" deep link → routes back to the in-app card surface.
