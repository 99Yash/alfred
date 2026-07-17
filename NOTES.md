# Teaching Notes

- Preferred style: like a junior engineer watching a film, with each frame naming the actor, durable state before/after, and reason for the handoff.
- Sequence: one concrete case at a time. Do not front-load a combinatorial map of failures, HIL approvals, and recovery paths.
- For prompt caching, teach from serialized requests and token accounting; connect every rule to Alfred's lazy tool surface.
- In every harness case, keep a four-lane ledger: durable run state, canonical transcript, provider-only prompt, and cache effect. Name when each prompt component is loaded and whether it survives the checkpoint.
