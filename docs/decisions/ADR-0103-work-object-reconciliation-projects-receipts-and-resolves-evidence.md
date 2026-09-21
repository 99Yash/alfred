# ADR-0103 — Work-object reconciliation projects receipts and resolves evidence

**Status.** Proposed; partly delivered. PR #1083 supplies the GitHub foundation, and #1088 delivered the resolve half — see ADR-0062's `Amended 2026-09-15 (#1088)`.

What #1088 landed: one shared reconciliation operation in `@alfred/assistant/connections/object-state`, a provider adapter that owns evidence-key proposals and canonicalization, and the move of closure and absorption from a global rule to a per-provider-and-kind policy (`ObjectKindDef.closesAskOn` / `ObjectKindDef.absorbing`). It takes a caller-supplied subject rather than the `reconcileDocuments(userId, documentIds)` signature below, because the pre-send guard reconciles composed prose and has no document, and the briefing gather already holds each row's text.

What remains open: the receipt half (`projectReceipt`, durable state-receipt provenance, one-to-many deltas in one transaction), the Sentry adapter and its transition-order proof, and the adapter's legal-transition rule. The five adapter duties below are therefore still the target; #1088 implemented two of them.

## Decision

Put one `work-object reconciliation` module in `@alfred/assistant/connections/object-state`. Its caller interface has two operations:

```ts
type ProjectResult =
  | { kind: "applied"; objectCount: number }
  | {
      kind: "ignored";
      reason: "missing_or_unowned" | "raw" | "unsupported" | "invalid_payload" | "no_delta";
    };

interface ClosureFact {
  documentId: string;
  provider: ObjectStateProvider;
  kind: string;
  externalId: string;
  objectTitle: string | null;
  objectUrl: string | null;
  stateCategory: LoopClosingStateCategory;
  nativeState: string;
  stateReceiptId: string;
  observedAt: Date;
}

interface WorkObjectReconciliation {
  projectReceipt(input: { userId: string; receiptId: string }): Promise<ProjectResult>;
  reconcileDocuments(input: {
    userId: string;
    documentIds: readonly string[];
  }): Promise<readonly ClosureFact[]>;
}
```

`projectReceipt` reads the user-owned typed `event_receipts` row. The checked-in ingress path must have verified and attributed the delivery before it stored the row. The caller cannot pass a payload, timestamp, provider state, or closure claim. A raw receipt or an event kind without a reviewed object-state adapter cannot update authoritative state. One receipt may produce zero or several deltas for **its own provider**; the module applies them in one transaction and records the receipt ID on each current-state update. A malformed typed event that yields no valid state is an explicit no-op with a diagnostic. A database failure throws so the delivery job can retry.

`reconcileDocuments` reads user-owned documents or their durable referent identities, proposes exact provider keys, resolves current objects, and returns only positive closure facts. A fact names the document, provider, object kind and native ID, native and normalized state, object URL/title, the state receipt ID, and the observation time. A document with no key, several plausible primary objects, missing current state, or an unsupported provider yields no fact. The caller keeps that ask. An infrastructure read failure throws; a workflow that chooses to continue must keep all asks and report the failed read. Briefing gather calls this operation on uncapped priority documents, removes only items with a fact, records the facts, and then caps the visible buckets.

The module's private provider adapter owns five rules: receipt reduction, evidence-key proposals, key canonicalization, legal lifecycle transitions, and whether a native state closes that kind of ask. The shared implementation owns user scope, exact lookup, receipt provenance, atomic writes, and result shape. `@alfred/contracts` holds only browser-safe fact contracts that a briefing or sync reader needs. The existing `ObjectStateStore` remains a storage/read implementation for chat, context search, and the day-shape list; its current `applyEvent` call is replaced by receipt projection for authoritative writes.

## Why this seam

PR #1083 matches a normal GitHub PR email by canonical PR URL as well as head SHA. It also carries closure facts to compose and storage. Its gather path still extracts GitHub keys, chooses one, reads the object-state store, and decides closure. A second provider would copy these rules into the briefing caller. The proposed module moves them behind one interface and lets document identity move from text parsing to ADR-0092 referent identities without a caller change. The GitHub parser from PR #1083 stays as a compatibility path until the durable identity projection covers those messages.

GitHub and Sentry prove that the internal adapter seam varies. A GitHub merge is irreversible, so `merged` may be absorbing. A Sentry issue can regress after resolution, and an archived issue can later escalate or be unarchived. The present store rule that every `resolved` object is absorbing must move to the provider-and-kind transition policy. Sentry `issue_resolved` and `issue_unresolved` can project `resolved` and `active`; `issue_archived` must retain its native state but must not close a fix request until archive policy is reviewed. [Sentry issue status](https://docs.sentry.io/product/issues/states-triage/) describes regression, escalation, and unarchive; [Sentry integration metadata](https://docs.sentry.io/api/integration/retrieve-a-custom-integration-by-id-or-slug/) lists resolved and unresolved webhook kinds.

## Order, authority, and propagation

An adapter may use a provider transition version or time only when the provider documents it and the payload validates it. Otherwise the shared writer orders by receipt delivery time with a deterministic receipt-ID tie-break. The order check and update must be atomic for each object, so concurrent jobs cannot both pass a stale read. Delivery time orders Alfred's observations; it does **not** prove closure or necessarily order provider transitions. Sentry's issue `lastSeen` is an occurrence time, not a verified lifecycle clock. A delayed resolve can arrive after an unresolve and falsely restore `resolved`. Therefore the first Sentry slice may project state, but it cannot suppress a Sentry ask from `resolved` until a reliable transition order or a fresh provider-state confirmation is implemented. GitHub merge remains safe under its absorbing transition rule.

A shared ADR-0092 referent means two reports are about the same thing. It does not mean one provider's lifecycle transition changes another provider's native state. A `mentions` relation never propagates closure. Later cross-provider closure needs an explicit, trusted `closes` relation and a target-kind policy; it yields a derived closure fact rather than rewriting the target object's native state. That propagation is outside the first slice.

Issue #1082 remains a separate post-compose, pre-send guard. It must check current state again before send, because a stored briefing fact can become stale. It may consume the provider-neutral fact shape, but it must also determine whether the composed sentence is an open ask. The reconciliation module does not make that prose judgment.

## Alternatives

- Keep `resolveByKey` and `getState` as the briefing interface. This leaves sender gates, primary-key selection, ambiguity, and closure policy in every caller.
- Accept caller-supplied payloads in a generic `applyEvent`. This lets an unreviewed caller assert state and hides whether ingress verified the delivery.
- Expose a swappable database port now. There is one storage implementation and no current need for a second one. Keep the database seam internal until real variation appears.
- Make `resolved` globally absorbing. This would prevent Sentry issues from reopening.

## Implementation proof still needed

The next slice adds a Sentry adapter and moves the global transition guard into provider policy. It must add durable state receipt provenance, handle one-to-many receipt deltas atomically, and compare a current projection against a trusted Sentry read or lifecycle clock before Sentry closure suppresses an ask. It must show that unknown and ambiguous evidence keeps the ask, that a Sentry unresolved event reopens a resolved issue, and that a GitHub merge cannot regress. Follow the repository rule to use compiler checks, runtime parsing at the owning boundary, and `pnpm check` rather than new feature tests.

This decision extends ADR-0062's provider reducer and object-state store. It follows ADR-0097's verified ingress and ADR-0090's retained receipt, and it uses ADR-0092's referent identities as evidence proposals. PR #1083 remains a GitHub-only foundation and does not need this module to merge.
