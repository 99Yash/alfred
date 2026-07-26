# ADR-0061 — Replicache stays (maintenance-mode dependency accepted), Zero is the watched migration path


**Decision.** Alfred's sync layer **stays on Replicache, pinned to `15.3.0`**, and we **deliberately accept that its upstream (Rocicorp) is in vendor-declared maintenance mode** and steers new users toward its successor, **Zero**. This is the decision record ADR-0001/0002 implied but never stated: ADR-0001 adopted Replicache for multi-device sync, ADR-0002 called it "the riskiest moving piece," but neither acknowledged the frozen-dependency lifecycle. This ADR converts that implicit risk into a tracked choice and names the revisit trigger.

**Why accept the frozen dependency for now.**

1. **It is feature-complete and runs on owned infra.** Replicache is a client library + a push/pull protocol we implement ourselves (`packages/api/src/modules/replicache/*`, CVR in `cvr.ts`, server mutators, poke bus). There is no Rocicorp-hosted service in the loop — maintenance mode means no new upstream features, not a service that can be shut off. The sync we have works and has no missing capability the product needs.
2. **The cost of the pin is bounded and visible.** `15.3.0` is pinned in `pnpm-workspace.yaml`; the client lives behind `apps/web/src/lib/replicache/` and the protocol behind the API module. A security/Node-compat issue in a frozen lib is the real tail risk, but the surface is small and self-hostable.
3. **Migrating now would be premature.** Zero is a different model (query-driven sync vs. mutator+CVR). A migration is a sync-layer rewrite touching every synced entity (todos, notes, briefings, action-stagings, triage tags, chat, workflows, feature flags, action policy). At single-user scale with a working sync layer, that is cost without current benefit.

**Revisit trigger.** Migrate to (or re-evaluate) **Zero** when any of: (a) Replicache `15.3.0` hits a security or Node-version-compat break we can't patch around; (b) the product needs a sync capability the mutator+CVR model makes expensive that Zero's query-sync makes cheap (e.g. large read-set partial sync); or (c) Zero reaches a maturity/stability bar comparable to what Replicache offered at adoption. Until one fires, the pin stands.

**What this builds on.**

- **ADR-0001** — adopted Replicache for multi-device sync; this records its dependency lifecycle, which ADR-0001 omitted.
- **ADR-0002** — named Replicache "the riskiest moving piece" (adoption risk); this is the distinct frozen-dependency risk.

**Known smaller hardening in this area (tracked, not blocking).**

- `serverMutators` is `as const`, not `satisfies Record<MutatorName, ServerMutator>` (`server-mutators.ts:73`), so a client mutator with no server impl is dropped at runtime rather than caught at compile time. Deferred: the mutators have heterogeneous arg types, so a clean `satisfies` needs a shared `MutatorName` union first.
- Post-TTL (12h) cold re-sync has no client "syncing…" indicator (`cvr.ts`; no sync state exposed in `context.tsx`). A UX gap, not a correctness one.

**Alternatives.**

- (a) **Migrate to Zero now.** Rejected: a full sync-layer rewrite for no current capability gain, against a successor still maturing.
- (b) **Fork/vendor Replicache to self-maintain.** Rejected as premature: takes on maintenance cost before any upstream break has forced the question. Reconsider only if revisit-trigger (a) fires.
- (c) **Leave it undocumented.** Rejected — that is the status quo this ADR closes: an unstated frozen dependency is a risk nobody owns.
