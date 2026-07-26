# ADR-0030 — Composer `+` menu and tab-autocomplete: deferred to post-m13


**Decision.** The composer's `+` button (in place of the older paperclip) and tab-autocomplete suggestion both ship as decoration-only in m12, with real behavior deferred:

- **`+` menu** — two items only at v1, mirroring dimension's recon (`chat-anatomy.md` §"Composer 'Add' menu"): `Add photos & files` and `@ Mention`. File upload pipeline depends on the ingestion stack post-m7; @-mention depends on the boss agent's awareness of skills/integrations (m13).
- **Tab-autocomplete suggestion** — when the boss agent has a probable next-prompt for the user, the placeholder is replaced with dimmed-text + a `[Tab]` keycap; Tab accepts. Depends on the boss agent producing those suggestions (m13) and the `agent.suggestion` event flowing over the existing SSE bus (ADR-0005).

**Why.**

- **The chrome is cheap; the behavior isn't.** Rendering a `+` icon and an empty popover takes minutes. The actual file-upload pipeline (chunker boundaries, dedup against `documents`, embedding budget per ADR-0010) is multiple PRs and likely needs its own ADR when it lands. Same for @-mention indexing — it needs to know the skill/integration registry the boss agent builds.
- **Don't ship half-wired affordances.** A `+` button that opens an empty menu is worse than no button. Disabled + tooltip ("Files & mentions — coming soon") matches the rest of the m12 stub surface (model picker, mic) honestly.
- **Tab-autocomplete is a m13 emergent behavior, not a m12 feature.** The suggestion only makes sense once there's an agent producing a continuation. Shipping the keycap UI before then would be cosmetic.

**When this becomes a real ADR.**

- File-upload pipeline: probably ADR-003x when post-m7 attachments land, covering MIME whitelist, dedup with the Gmail attachment path, max-size, virus-scan stance.
- @-mention: probably folded into ADR-0017 (skills) or a new ADR if the index turns out non-trivial — e.g. if mentions index people from contacts/Gmail headers in addition to skills/workflows.
- Tab-autocomplete: a small ADR when m13 has produced a real suggestion stream. Likely just "boss agent emits `agent.suggestion` over SSE; composer subscribes; one-shot per turn."

**Alternatives.**

- (a) Ship the `+` menu now with stubbed file-upload (rejected — invites half-broken UX; the upload box is meaningful surface area, not chrome).
- (b) Drop the `+` icon entirely and bring it back when behavior exists (rejected — keeps dimension parity worse than necessary; the icon being there + disabled signals intent without lying about what works).
- (c) Implement Tab-autocomplete with a stub suggestion (rejected — same problem as (a); fake suggestions train wrong muscle memory).
