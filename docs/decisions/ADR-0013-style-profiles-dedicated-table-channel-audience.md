# ADR-0013 — Style profiles: dedicated table, channel × audience keyed


**Decision.** Dedicated `style_profiles` table. Each row = `(channel, audience_bucket, optional recipient_id) → profile_doc + few-shot examples + provenance`. Lazy materialization: generic-per-channel profiles seed at signup; narrower profiles generated in background on first need.

```
style_profiles
  id, user_id
  channel              enum(gmail, imessage, slack, doc, code_review, twitter, generic)
  audience_bucket      enum(family, friend, peer, manager, customer, vendor, public, generic)
  recipient_id         nullable      -- specific person if narrower than bucket
  profile_doc          text          -- LLM-readable style guide
  examples             jsonb         -- 3-5 representative samples
  source_msg_ids       jsonb         -- provenance into chunks/messages
  generated_at         timestamp
  generated_from_count int
  confidence           float
  status               enum(draft, active, superseded)
  superseded_by        uuid?

  unique(user_id, channel, audience_bucket, recipient_id)
```

**At draft-time:** look up most-specific applicable profile (`recipient_id` > `audience_bucket` > `channel-generic`). Multi-channel drafts (e.g., post to Slack and Gmail simultaneously) generate one draft per target with each target's own profile in the prompt — never merge two profiles.

**Why both `profile_doc` and `examples`:** doc tells the LLM _what_ the style is in words; few-shot examples in the prompt outperform a written guide for actual style transfer. Use both: doc as instructions, examples as evidence.

**Audience-bucket assignment** comes from `user_facts` (alfred infers `relationship:alice@… = manager` from signatures, calendar invites, message patterns). User correction updates the fact, which changes the profile lookup.

**Privacy / regen rules.** Profile rows store `source_msg_ids`, not corpus content. When user deletes a source message, profiles citing it get `regenerate_needed`. Profiles must opt out of citing alfred-generated drafts (avoid circularity). Distilled profile + RAG examples replaces both fine-tuning (privacy risk: corpus leaves to OpenAI/Anthropic) and full-corpus per-call RAG (cost + variability).

**Alternatives.**

- One global profile doc (rejected — formal-Gmail vs casual-iMessage contradict each other).
- Pre-fill all `(channel × audience)` combos (rejected — combinatorial blow-up, mostly empty rows).
- Fine-tune a model on corpus (rejected — privacy + drift + cost).
- Per-call full-corpus RAG (rejected — every draft pays retrieval cost; doc + examples is cheaper and deterministic).
