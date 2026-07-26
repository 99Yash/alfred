# ADR-0063 — Integration extraction front-door (DEFERRED — framed, not yet designed)


**Status: deferred to its own grill.** Recorded now so ADR-0062 has a named seam and the next session starts ahead instead of cold. Nothing here is decided beyond the invariant.

**What it is.** The *propose-only* capture layer (layer 1 of the three-layer model) that turns inbound material — emails primarily, documents next — into **typed candidate keys** (fed to ADR-0062 object-state) and **work-signals** ("Yash is shipping X", fed to ADR-0057 user-memory). One front-door, two sinks.

**The one thing that is decided — the invariant it must honor.** Propose-only. It may emit candidate keys + signals; it may **never** assert external-object state. Resolution and state are deterministic (ADR-0062). This is non-negotiable because it is what protects ADR-0048's contract test.

**v1 stopgap (so #212 / ADR-0062 doesn't block on this).** The registry's `extractKeys(document)` slot is filled with a **deterministic** GitHub-CI key-extractor (the `head_sha` is a literal 40-hex string — a regex is a legitimate dumb proposer behind the stable interface). This ADR's real design *replaces/augments* that slot with the boss-driven rich extraction.

**Open questions for the dedicated session.**
- **Trigger / cadence.** Inline-at-ingestion vs concurrent-with-triage-tagging vs an extension of `memory.extract.daily` (ADR-0057). The user wants it "as real-time as possible" and synchronous, driven by integration activity over time.
- **The poll-vs-webhook real-time asymmetry.** GitHub *pushes* (webhook-real-time); Gmail is *polled* (email extraction is poll-cadence-bound at best). "Real-time" is two different latency stories; the architecture must own that.
- **Ordering vs triage tagging.** Extracting *before* tagging lets triage demote at the source (the merged-PR CI email never enters the demanding lane); *after* enriches an already-tagged email. The determinism contract implies a both-and (opportunistic-demote + briefing catch-up), but the ordering decision shapes the pipeline.
- **Cost / gating at dozen-user scale.** A boss-per-email lane is real money + latency. Likely: cheap triage tier for the common case, escalate to boss only when there's structured signal to pull.
- **Model + output contract.** What typed shape does the extractor emit, and how is it validated at the boundary so a hallucinated key is rejected before `resolveByKey`.
