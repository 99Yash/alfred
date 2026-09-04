# ADR-0096 — A read-only MCP surface downgrades the `mcp.call` approval floor STRUCTURALLY, with no per-descriptor review

**Decision.** `mcp.call`'s `high` approval floor drops to `low` for a tool that satisfies two independent, durably-recorded conditions: its connection's endpoint is a built-in read-only protected resource (`builtInReadOnlyResource`, ADR-0094), AND the published catalog recorded that tool's own `annotations.readOnlyHint` as true (`mcp_catalog_revisions.read_only_hints`). No `mcp_tool_policy` row is required.

Four sub-decisions follow:

1. **A reviewed policy row wins outright, in both directions.** It is the user's explicit decision about one exact descriptor, so it must be able to RAISE the tier as well as lower it. A row whose persisted tier is out of enum takes the floor and does NOT fall through to the structural branch.
2. **A tool the user has EVER reviewed never takes the structural branch.** If a reviewed descriptor has drifted, the exact-hash lookup misses, and the answer is the floor — not a fresh structural downgrade. The structural branch would re-prove that the NEW descriptor is a read, which is true and is not the question: a review that RAISED the tier would otherwise be cancelled by a server-side description edit, silently. `resolveMcpToolIdentity` answers this with one hash-blind `exists` over `mcp_tool_policy`, in the same query.
3. **The per-tool claim is PROJECTED at publication, not scanned at the gate.** `projectCatalogRevision` writes `{ [remoteName]: boolean }` beside `descriptor_hashes`, so the gate resolves one tool by name.
4. **The risk gate re-reads the claim from persisted state.** It does not infer "this catalog is all reads" from the fact that the ADR-0095 admission gate exists.

**Extends ADR-0088** (the floor stays a floor; this adds a second authority for lowering it). **Depends on ADR-0094** for the read-only resource pin and the annotation condition. **Does not change ADR-0069**: the autonomy toggle still cannot lower anything.

---

## The problem this fixes is a cost asymmetry, not a missing feature

Two doors answer a GitHub question. `github.search` and its siblings are curated reads carrying `riskTier: "no_risk"`, so they cost the user nothing. `mcp.call` carries `high`, so every call stages an approval.

Both doors read the same private repositories under the same `repo` grant. So Alfred already grants approval-free private-repository reads; the MCP door charges an approval for the identical read because it was built second and behind a conservative floor. That is not a security posture, and the fix is not to make the cheap door expensive.

The consequence today is that a read-only MCP call cannot compete with a curated read, which makes the whole MCP catalog decorative. This ADR is what makes the catalog usable at all.

## Why the reviewed path was not the answer on its own

`mcp_tool_policy`, `upsertToolPolicy`, and the whole ADR-0088 fail-closed resolver are BUILT. `upsertToolPolicy` has **no production caller** — only tests. So the reviewed downgrade is complete and unreachable: there is no surface on which a user can record a review.

Wiring that surface was the obvious alternative and it is rejected as the SOLE mechanism for the same reason ADR-0094 rejected its alternative (b): it asks the user to be the read/write classifier, one descriptor at a time, on schemas they did not author and cannot fully evaluate. Alfred can answer the question structurally with two facts it already pins itself. Asking a human to re-answer it 28 times is not more safety, it is a worse oracle plus a cost.

## Why the structural authority is trustworthy

Neither condition is a claim Alfred takes from the model or from the call.

- `readOnlyResource` is pinned in Alfred's own built-in registry. A server cannot set it.
- `readOnly` was projected from the descriptor the catalog actually published, at publication, from a typed `Tool`.

**Publication DERIVES the projection; it does not accept one.** `PublishCatalogRevisionInput` takes `descriptors: readonly Tool[]` and nothing else about the catalog. `projectCatalogRevision` builds the hash map and the read-only map in one loop over that array, so no caller can hand the database a read-only map that claims `true` for a tool its own descriptors call a write. That is stronger than the name-coverage check this ADR originally shipped with: a coverage check proves the map covers the right NAMES and says nothing about the values, so `Object.fromEntries(tools.map((t) => [t.name, true]))` would have passed it and granted a downgrade to every tool in the catalog.

A server CAN lie by asserting `readOnlyHint: true` on a write tool. That defeats this condition and does not defeat the resource pin, which serves no write tool. The two controls fail in different directions, which is the same argument ADR-0094's amendment makes for admission, applied one layer up.

The layering is the point of sub-decision 4. Admission runs in `McpRawClient`; the risk gate runs in the dispatcher against the database. If the gate inferred "read-only endpoint implies every tool is a read", then a revision published before ADR-0095 — or by any path that skipped the client — would inherit a downgrade nothing checked. Reading the projected claim costs one JSON key lookup and removes that inheritance.

## What is deliberately NOT downgraded

- **A user-added server.** `readOnlyCatalog` is false for every endpoint no built-in claims, so it keeps the `high` floor. It has no downgrade path at all until the reviewed surface is wired, which is stated as residual risk below.
- **A tool with no annotation.** An absent optional annotation carries no claim. `projectCatalogRevision` records `false`, and the gate needs a `true`.
- **A tool with a reviewed row under a drifted descriptor.** Sub-decision 2. This costs a downgrade the structural branch could otherwise grant, and it is the only reading faithful to a review that raised the tier.
- **Any revision published before this change.** Migration `0113` defaults `read_only_hints` to `{}`. There is no backfill, on purpose: a pre-ADR-0095 revision was never checked against the read-only surface, so backfilling would grant a downgrade the admission gate never authorized. Republication with the SAME revision hash does not repair it either, because publication is `onConflictDoNothing`.

## Why `low` and not `no_risk`

Only `high` gates, so `low` is already approval-free and costs the user exactly what a curated read costs. It stops short of `no_risk`, which the curated reads carry, because the two are not the same claim: a curated read is an Alfred-authored call with a fixed shape, while an MCP read runs a server-authored schema against model-chosen arguments. The distinction changes nothing about the gate; it keeps the tier honest about what it is describing.

## Alternatives

- **(a) Wire a manual per-descriptor review surface and keep the floor otherwise.** Rejected as the sole mechanism, per the argument above. It stays desirable for user-added servers.
- **(b) Downgrade every tool on a read-only-pinned connection, without reading the per-tool claim.** Rejected. It is one condition dressed as two, and it makes the gate inherit an assumption about the admission path having run. The extra cost of not doing this is one JSON key lookup.
- **(c) Downgrade to `no_risk`.** Rejected as dishonest about the argument shape; see above. It would also make an MCP read indistinguishable from a curated read in every audit view.
- **(d) Leave the floor alone and accept a decorative catalog.** Rejected as an accidental decision. If the MCP-only GitHub direction is to end, it should end explicitly, not because the approval cost made it unusable.
- **(e) Let a corrupt policy row fall through to the structural branch.** Rejected. A present-but-unreadable review is an uncertainty, and ADR-0088's rule is that every uncertainty takes the floor. Falling through would let a corrupt row read as "no review", which is strictly weaker than what the row was trying to say.
- **(f) Let a DRIFTED reviewed row fall through to the structural branch.** Rejected, per sub-decision 2, and for the reason of (e) one step further out. The alternative considered was to bind the structural branch to the same descriptor hash the review binds to. That is a larger change for the same outcome, because the hash is already what produces the miss.
- **(g) Accept a supplied read-only map at publication and check its name coverage.** Rejected — this is what the first version of this decision shipped. See "Publication DERIVES the projection" above. The check was real, and it guarded the wrong axis.

## Residual risk

- **`upsertToolPolicy` still has no production caller.** A user-added server therefore has no downgrade path whatsoever. This ADR does not fix that; it makes the built-in case not depend on it.
- **The structural downgrade is not audited per call.** ADR-0088's residual (1) already names the missing breadcrumb: the staging row persists the EFFECTIVE tier, not the authority that produced it. A structural downgrade is now a second unnamed authority in that same gap. The dispatcher's `riskTierDowngradeReason` log records that a downgrade was allowed, not which of the two branches allowed it.
- **A read is not nothing.** A downgraded read still pulls private repository content into the model's context. The argument here is a comparison to the curated reads, which do the same thing for free — not a claim that reads are harmless. If that posture changes, it must change for BOTH doors, and this ADR is then the wrong half to revisit first.
- **`read_only_hints` is projected for EVERY server, not only for a read-only built-in.** It is derived from the descriptors, so a user-added server's revision also records what its tools claimed. Nothing reads it there today, because a downgrade needs `readOnlyResource` as well. But if a later registry edit ever claimed an endpoint a user had already added, that connection's existing revisions would become downgrade-eligible on a claim the ADR-0095 `write_tool` gate never saw — the same inheritance this ADR refuses for pre-0113 rows. No door creates that state today: `ensureBuiltInConnection` mints the built-in row, and a user-added row keeps the endpoint the user gave it.
- **A structurally downgraded tool still pays the RECOVERY cost of an effectful call.** The downgrade removes the approval prompt and nothing else. With no `mcp_tool_policy` row, the tool's `effectClass` is `unknown`, so the broker takes the effectful ledger path: an ambiguous failure on a READ becomes a blocked barrier that needs a recovery decision. A curated `github.*` read never does that. Closing this gap means giving the structural branch an effect-class opinion too, which is a separate decision.
- **No test proves the branch table**, per repository policy. The compiler cannot reach a runtime tier decision, so the proof is `references/scratch/probe-structural-risk-downgrade.ts`, which drives `resolveMcpCallRiskTier` against a real database over ten rows and reads them all as designed: read-only endpoint with a published hint is the ONLY row that reaches `low`; a missing hint, an ordinary endpoint, a corrupt reviewed tier, a drifted review in either direction, and a stale catalog revision each hold `high`; and a reviewed row on the exact descriptor moves the tier in both directions. The probe publishes real `Tool` descriptors and lets `projectCatalogRevision` derive the hint, so the `true` branch runs through the same projection production uses. Being a scratch probe, nothing re-runs it — a later edit to `effectiveMcpRiskTier` has no gate behind it.
- **`test/mcp/risk.test.ts` was in the `tsconfig.test.json` exclude baseline** when this landed, so its `publishCatalogRevision` fixture was repaired against a red test run rather than a compile error. Three MCP suites sit in that baseline (`risk`, `manager-lifecycle`, `streamable-http`); until they leave it, a compile-time proof about this path is weaker than it looks.
