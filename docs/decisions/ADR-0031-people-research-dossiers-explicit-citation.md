# ADR-0031 — People research dossiers: explicit, citation-grounded, review-before-memory

**Decision.** Add a first-class people-research capability that produces comprehensive, citation-grounded dossiers for people the user asks Alfred to understand. This is **not** an extension of `user_facts`: it researches third parties, stores the profile separately, and only promotes relationship facts into durable memory after review.

The implementation shape mirrors cold-start research (ADR-0011) but generalizes the subject:

- `packages/api/src/modules/people-research/` owns `collectPersonSignals` → `researchPerson` → `extractPersonProfile` → `persistPersonProfile`.
- Deep dossier runs use `getResearchModel()` / Perplexity Sonar Deep Research via `meteredGenerateText(..., attribution.kind = 'web_search')` (ADR-0022). Lightweight "quick lookup" can use `getWebSearchModel()` / Sonar Pro when the user asks for a short answer, but saved profiles come from the deep path.
- The durable runtime executes the pipeline as a workflow/run (ADR-0006), so 30-120s latency and retry/idempotency are handled like cold-start research.
- Output lands in `entities` / `entity_relations` plus dedicated profile tables, not in `user_facts` by default.

**Target output.** A saved dossier should have a stable, scannable shape:

- Identity match: canonical name, aliases/handles, identity confidence, matched signals, possible false matches.
- Professional: role, company, industry, public work history, notable projects.
- Organization context: company summary, stage/size/location, product/category, competitors where relevant.
- Connection to user: shared company/school/location, email/calendar/contact evidence, mutual context from user-owned integrations.
- Public relationships: family, cofounder, advisor, investor, collaborator, or other relationship context only when the relationship is publicly attested by a reliable source or present in user-owned data. Family discovery is allowed as a searched section when the user asks for deep people research, but weak/private findings stay in research notes or are omitted.
- Digital presence: LinkedIn, GitHub, X/Twitter, website/blog, other public profiles, each marked high-confidence or tentative.
- Education/location/interests: only when publicly attested or directly present in user-owned data.
- Unknowns: important fields that were searched but not confidently found.
- Research notes: disambiguation caveats, source-quality notes, and non-persisted weak inferences.
- Sources: citation list; every persisted claim must point to at least one source.

**Storage shape.**

```
person_profiles
  id, user_id, entity_id
  subject_name, subject_email?, subject_company?, subject_handles jsonb
  identity_confidence float
  summary text
  sections jsonb              -- rendered dossier sections
  sources jsonb               -- canonical source list
  research_notes text
  status enum(draft, saved, archived)
  run_id, created_at, updated_at

person_profile_facts
  id, user_id, profile_id, entity_id
  key, value jsonb, confidence float
  source_urls jsonb, rationale text
  sensitivity enum(public, user_owned, speculative)
  status enum(proposed, accepted, rejected)
```

`entities(kind='person')` remains the canonical graph node. `entity_relations` captures relationships (`works_at`, `met_with`, `emailed_with`, `same_school_as`, `reports_to`, etc.). `memory_chunks(kind='person_profile')` may hold the freeform dossier summary for semantic recall, but `user_facts` is reserved for facts about the user. A relationship fact such as "Alice is my manager" can be proposed into `user_facts` only through the existing correction loop (ADR-0019).

**Triggers.**

Start explicit-only:

- Chat/tool call: "research this person", "who is this candidate?", "prep me for meeting with X".
- Contact/profile UI action: "Research" or "Refresh profile".
- Workflow step: a user-authored or built-in workflow calls `research_person`.

Later, allow opt-in proactive triggers:

- upcoming meeting with an unknown external attendee,
- first substantial email thread with a new sender,
- imported contact with enough identifying signals.

No silent background research of arbitrary contacts at v1. Proactive triggers create a draft/review card, not an auto-saved profile.

**Quality rules.**

- Identity disambiguation is a first-class output. If the subject cannot be distinguished from similarly named people, return "no confident match" or a draft with caveats.
- Every accepted fact needs source provenance. Prefer public pages, company/team pages, personal sites, GitHub profiles, conference bios, and user-owned email/calendar/contact signals over SEO scraper pages.
- Weak inferences are allowed only in `research_notes`, never as accepted facts. Examples: age/career stage guessed from graduation year, cultural generalizations from location, surname guesses, or "likely works in X" from company makeup.
- Unknowns are valuable output. A sparse but honest profile is better than a padded one.
- The extractor is conservative: confidence below 0.7 is dropped; 0.7-0.9 remains proposed; 0.9+ can be accepted into the profile only if the user explicitly saves the dossier. Relationship facts still follow ADR-0019's correction UX.

**Privacy and safety boundaries.**

- Public web plus user-owned integrations only. Do not buy, scrape, or infer private data from people-search brokers.
- Do not include home address, personal phone, exact birthdate, government IDs, financial/medical data, or private family details.
- Family or relationship details for third parties are out of scope for quick lookup and automated triage enrichment. Deep people-research may search for publicly attested family/relationship context when the user asks for a dossier, but the output must stay source-cited, high-confidence, non-sensitive, and short; minors and private-family details are omitted.
- Do not run continuous monitoring of a person. "Refresh profile" is an explicit action or a narrowly scoped workflow step.
- Dossiers are for the user's personal context and preparation, not for automated outreach personalization that pretends to know private details.

**UX.**

- Saved profiles are reviewable/editable. The first deep run returns a draft card with section-level source links and fact-level accept/reject controls.
- The user can save the full dossier, save only relationship context, or discard.
- Low-confidence facts remain visibly proposed. Rejections should feed `rejected_inferences` so Alfred does not keep re-suggesting the same weak match.
- In chat, Alfred may answer from an existing profile but should mention stale profiles and offer a refresh when recency matters.

**Why separate from cold-start research.**

Cold-start is lifetime-once, self-research, and writes into `user_facts`/`memory_chunks` because the subject is the user. People research is repeatable, subject-specific, and often about someone else. Collapsing both into `user_facts` would pollute the user's memory with third-party attributes and make correction semantics unclear.

**Alternatives.**

- (a) Reuse cold-start research with a different prompt (rejected — wrong storage semantics, weak privacy boundary, and no person-identity lifecycle).
- (b) Live-only web search answers with no persistence (rejected — misses the dimension-style "assistant knows the people around me" value and repeats expensive research).
- (c) Auto-research every email sender/contact (rejected for v1 — cost, privacy, and false-positive risk; proactive research must be opt-in and review-first).
- (d) Put third-party facts directly into `user_facts` (rejected — `user_facts` should describe the user; third-party facts belong to profiles/entities, with only relationship facts proposed back to user memory).

**Open.**

- Whether `person_profiles` should Replicache-sync in v1 or stay server-rendered until the profile UI exists.
- Whether the dossier profile table should generalize to `entity_profiles` for organizations/projects/products. Start with people unless implementation shows the abstraction is free.
- Whether quick Sonar Pro lookups should ever be persisted, or only deep-research outputs.

**Amendment (2026-05-26) — triage-driven auto-trigger + confidence-tier TTL caching (ADR-0042).**

The "later, allow opt-in proactive triggers" line in the Triggers section gains a concrete first proactive trigger: triage's `deepen` step (ADR-0042). When the escalation gate fires live on an unknown human sender in `urgent` / `action_needed` / `awaiting_reply`, the triage workflow enqueues this ADR's `person-research` workflow as an async side-effect, NOT a blocking step. The current email's classification proceeds without the dossier; future emails from the same sender benefit from the cached profile. Initial rollout shadows this unknown-human branch (logs `wouldDeepen`, `wouldDeepenReason`, `deepenExecuted=false`, `shadowOnly=true`, and `dossierRequested=false`) until contact/memory quality and firing rate are observed; the live side-effect is enabled after that rate is acceptable. Privacy semantics intact — the dossier still surfaces as a review-before-memory draft card before any fact lands in `user_facts`; the "no silent background research of arbitrary contacts at v1" rule is preserved because the trigger is gated on triage importance, not on contact appearance. The `person_profiles` rows themselves act as a cache: stale-by-confidence-tier (`identity_confidence` ≥0.9 → 90d, `0.7-0.9` → 30d, `<0.7` → 7d) triggers re-research only when the sender re-appears in an important triage category. Cache key is the stable sender identifier — `email` for direct senders, `service:handle` for body actors (e.g. `github:coderabbitai`).
