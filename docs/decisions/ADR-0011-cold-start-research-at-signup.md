# ADR-0011 — Cold-start research at signup

**Decision.** On signup, kick off a `cold_start_research` BullMQ job. Inputs: email, optional GitHub username, work-email domain. Sources:

- Web search (Exa.ai, Tavily, or Linkup — TBD; Tavily/Linkup stronger for entity-research).
- Email domain → company info (Crunchbase / website / LinkedIn page).
- Public GitHub commits/repos/orgs.
- Personal site (often discoverable).
- Public social handles (Twitter/Bluesky/Mastodon).

Outputs land in the memory layer: `user_facts` rows with `confidence`, `source`, `status='proposed'` for user confirmation; freeform research summary indexed in `memory_chunks`.

**Why.** Lets alfred bootstrap with non-zero context before any integrations are connected. Mirrors dimension's onboarding research per Ronit's blog.

**Alternatives.** Cold-start from zero (rejected — empty assistant for first weeks).

**Open.** Web search provider choice deferred (Exa vs Tavily vs Linkup).
