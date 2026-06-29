# Identity facts as a projection over the observation log (v1)

**Status:** DESIGNED (grilled 2026-06-29). ADR-0080. Projection not built.
**Epic:** #218 user-model spine. Builds on ADR-0067 (observation substrate), ADR-0079/#330 (deterministic capture brake), and #329/#331 (read rescue + purge evidence).

## Current repo state

ADR-0079's capture brake is already code, not future work:

- `@alfred/contracts` has the canonical fact ontology, key aliases, and `canonicalizeFactKey`.
- `packages/api/src/modules/memory/fact-policy.ts` has the document tiering, value validation, conservative authorship gate, and single-valued key set.
- `proposeFact` canonicalizes keys for all sources, blocks unsafe document writes, and holds autonomous single-valued conflicts as `proposed`.
- The purge script `apps/server/src/scripts/backfill-purge-document-facts-committed.ts` uses the same gate.

This plan starts **after** that brake. ADR-0079 is still valuable, but only as a deny-brake for legacy/direct-write paths while identity keys move to projection ownership.

### Build status (2026-06-29)

The **deterministic core** of slice 1a (invariant 3 — the unit-tested, no-DB, no-LLM pieces) is built and green:

- `packages/contracts/src/identity-affiliation.ts` — the four-outcome **domain classifier** (`classifyEmailDomain`), the **grounding-tier ladder + authority ranking** (`GROUNDING_TIERS`, `groundingTierRank`, `isStrongerGrounding`), the per-key **grounding rule** (`canGroundIdentityKey` — corporate domain grounds `employer` only; `weak_mentions` never promotes), and the affiliation→tier map (`affiliationGroundingTier` — the "no grounding, no row" contract in code). The free-mail list is now the ONE canonical set; `cold-start/signals.ts` delegates to it (no second list). This slice moves the existing cold-start list unchanged so registry deduplication does not change cold-start behavior. Full email-address classification is conservative: a custom-domain address needs provider hosted-domain verification (for Google, `hd`) before it becomes `corporate_domain`; otherwise it stays ambiguous.
- `user_org_affiliation` observation kind added to the contracts vocabulary and registered for the account-level `google_account` source (`OBSERVATION_KINDS_BY_SOURCE`), with `subjectIdentity = { kind: "user" }` and a typed `{ accountId, accountEmail, orgDomain, verifiedHostedDomain, domainClass, status, ... }` payload enforced by `observationInsertSchema`.
- `packages/api/test/contracts/identity-affiliation.test.ts` — 29 passing unit tests pinning every branch (classifier outcomes, rank order, per-key grounding, the work-account-grounds / personal-account-null end-to-end, source×kind wiring, lifecycle payloads, and malformed affiliation payload rejection).

Remaining slice-1a steps (all DB/runtime-bound — need a live Postgres + connected accounts to verify, so they are the next increment): the `identity_facts` **projection reducer** + materialization, the **connect-time emit** of `user_org_affiliation`, the **`/settings` + chat correction** emit as `user_profile_edit`/`user_correction` observations, the **backfill** script, the **`proposeFact` hard-block** for `employer`, and the **legacy-row retirement** at cutover (§6 steps 2, 4, 5, 6, 7, 8).

## 1. Problem

Prod resolved `employer = "Weekday"` on the personal account and `employer = "yourelasticdash.co"` on the work account. Both were third-party companies attributed to the user:

- Weekday came from an email by Sanjay Sivaraman, "Co-founder of Weekday"; the stored rationale said the company **he** is associated with.
- yourelasticdash.co came from mail involving `zifeng.liang@yourelasticdash.co`; the rationale said **his** company affiliation.

The root bug is not a tiebreaker. The legacy path:

```
memory-extraction workflow -> LLM fact proposal -> proposeFact -> user_facts
```

lets a per-document read create a durable identity fact. ADR-0079 now proves **authorship** for document-derived identity keys, but authorship is not enough. A user-authored email can mention a third party's company. The missing primitive is **aboutness**: whether the claim is structurally about the user.

The observation log already has that primitive: `subjectIdentity`. Identity facts should derive only from observations whose subject is the user.

## 2. Invariants

1. **No grounding, no row.** The projection never materializes an identity value without a traceable grounding observation. No evidence means no active row; consumers read `null` / "not recorded." A filled profile is never a reason to guess.
2. **Aboutness by construction.** Profile identity values derive only from observations with `subjectIdentity = { kind: "user" }`. Third-party-subject evidence cannot promote into user identity.
3. **Deterministic core, LLM at the edges.** The domain classifier, grounding rules, authority ranking, currency reducer, and single-active gate are deterministic and unit-tested. LLMs may propose observations or summarize prose; they do not decide authoritative identity.
4. **One authority model.** After cutover, the identity projection is the only writer for projection-owned identity keys in `user_facts`. `/settings` edits and chat corrections enter as `source=user` observations and win inside the reducer.
5. **Replay is pure.** Projection decisions use observation `occurredAt` and projection-run metadata, not ambient `now()`. Replaying the same observation set converges.
6. **Evidence-only never promotes.** `mentioned_company = "Weekday"` stays evidence. `interviewing_with = "Stripe"` is situational state. Neither becomes `employer`.

## 3. Architecture

**Authority:** ADR-0067 `observations`.
**Read view:** `user_facts`, because existing consumers already read it (`read_user_context`, triage, briefings, Replicache).
**Migration pattern:** invert the standing-instructions pattern. Standing instructions currently write the fact and append an observation; identity should append observations first and materialize facts from the projection.

### Three projections over one log

| Layer                | Examples                                                                                 | Contract                                                        | Consumer                |
| -------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------- |
| Identity profile     | `employer`, `job_title`, `team`, `manager`, `location`, `personal_site`, handles         | governed, current-active-with-history, one active value per key | boss profile / settings |
| Situational state    | `job_search_active`, `interviewing_with`, `shipping_velocity_high`, `awaiting_callbacks` | time-bounded, decaying, multi-valued                            | briefing tone           |
| Narrative adaptation | briefing wording and framing                                                             | reads projections; invents no durable facts                     | user-facing briefings   |

Hard boundary: situational companies never promote into identity. "Interviewing with Stripe" is not `employer=Stripe`.

## 4. Observation inputs

### 4a. Connected-account affiliation

On account connect, emit a first-party observation:

```ts
subjectIdentity = { kind: "user" };
kind = "user_org_affiliation";
source = "google_account"; // not "user"; account-level provenance, not a Gmail message
payload = {
  accountId: "google-sub-...",
  accountEmail: "yash@oliv.ai",
  orgDomain: "oliv.ai",
  verifiedHostedDomain: "oliv.ai",
  evidence: "connected_google_account",
  domainClass: "corporate_domain",
  status: "connected",
};
```

Why source is not `user`: an explicit user correction such as "I left" or "that is a client mailbox" must outrank the connected-account signal.

The domain is the grounding. The display label (`Oliv AI`) is derived and upgradeable by Directory; it is not the identity anchor.

On disconnect, emit a new observation in the same account/domain family with
`status: "disconnected"`. The projection derives currentness from observation
history, not from ambient credential state, so replay stays pure.

### 4b. Domain classifier

| Class                     | Examples                                                                                     | Employer signal                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `consumer_email`          | gmail, outlook, yahoo, icloud, proton                                                        | none                                                                    |
| `corporate_domain`        | oliv.ai, acme.com                                                                            | strong org-affiliation; may auto-confirm `employer` when uncontradicted |
| `ambiguous_domain`        | school, alumni, agency, unverified personal custom, shared-hosting child domains, disposable | affiliation maybe; employer requires corroboration                      |
| `service_or_role_account` | noreply, support, admin, list accounts/domains                                               | never employer                                                          |

Use a maintained free-mail denylist plus source/account-label checks. For full email addresses, provider hosted-domain verification is the account-label check that separates a Workspace account from a personal custom-domain mailbox. This classifier is deterministic.

### 4c. User corrections and profile edits

`/settings` profile edits and chat corrections emit `user_profile_edit` / `user_correction` observations with `source=user`. They are highest authority and must not bypass the projection by writing identity keys directly.

### 4d. Later grounding sources

Directory org membership, GitHub org membership, self-authored signatures/bios, and cold-start/public-profile research can all emit subject-user observations. They differ in grounding tier; they do not get special source branches inside the reducer.

## 5. Projection reducer

Projection-owned `user_facts` rows use `source.kind = "projection"` as a writer tag only:

```jsonc
{
  "kind": "projection",
  "id": "<projectionRunId>",
  "meta": {
    "projectionName": "identity_facts",
    "groundingTier": "corporate_affiliation",
    "derivedFrom": [{ "observationId": "...", "familyKey": "...", "source": "...", "kind": "..." }],
    "winner": true,
  },
}
```

Authority ranking reads `groundingTier` plus the underlying observation source, not the flat `"projection"` source:

```
user_correction
  > user_profile_edit
  > directory_verified
  > corporate_affiliation
  > self_authored_profile_or_signature
  > corroborated_public_or_cold_start
  > weak_mentions
```

Key-specific grounding matters:

- `employer` may be grounded by current corporate affiliation.
- `job_title`, `manager`, and `team` are **not** grounded by corporate domain alone. They require Directory, explicit user correction/edit, self-authored profile/signature, or corroborated first-party evidence.
- `location` and profile URLs need direct user-subject evidence; do not infer them from contact mail.

Materialization rules:

- Upsert by logical key `(userId, subject=user, key)`.
- One active row for single-active identity keys.
- Winner changes retire the previous row with `validUntil` and `supersedesId`.
- Replay uses observation timestamps and projection run metadata only.

## 6. Slice 1a: employer-only vertical

Goal: make `employer` projection-owned with the smallest complete path.

Build:

1. Add `user_org_affiliation` observation kind/schema and reducer support for connected accounts.
2. Backfill observations for already-connected accounts, dry-by-default and idempotent.
3. Implement the domain classifier with tests for consumer, corporate, ambiguous, and role/service accounts.
4. Add `user_profile_edit` / `user_correction` observation emission for `employer` changes from settings/chat.
5. Implement `identity_facts` projection for `employer` only:
   - corporate affiliation can emit `employer` when current and uncontradicted;
   - `source=user` observations override integration evidence;
   - no grounded winner emits no active row.
6. Materialize projection-owned `user_facts` rows with provenance metadata.
7. Hard-block legacy `proposeFact` / direct writes for `employer` once the projection is enabled.
8. Retire existing active legacy `employer` rows with migration semantics, not deletion.

Expected outcome:

- Work account grounded by `oliv.ai` resolves `currentCompany = "Oliv AI"`.
- Personal Gmail with no user-subject employer grounding resolves `currentCompany = null`.
- Weekday / yourelasticdash never produce active `employer`.

## 7. Slice 1b and later

Slice 1b extends the same machinery to:

- `job_title`
- `team`
- `manager`
- `location`
- `personal_site`
- `github_username`
- `twitter_handle`
- `linkedin_url`

Do not reuse the corporate-domain shortcut for title/manager/team.

Slice 2 adds situational state. Keep it separate from identity:

- `job_search_active`
- `interviewing_with`
- `awaiting_callbacks`
- `shipping_velocity_high`
- `travel_planning`
- `health_admin_open_loop`

Cold-start status primitives may feed this layer when evidence-backed: `student`, `founder`, `employed`, `retired`, `job_seeking`, `career_transition`, `open_source_active`, `shipping_heavily`. Do not infer demographic categories such as age or "should be working."

## 8. Capability-manifest constraint

The repo has had multiple hand-maintained source vocabularies (`INTEGRATION_SLUGS`, observation sources/kinds/ranks, briefing integration activity sources). Identity projection must not add another hard-coded source matrix.

Add or reuse one per-integration capability manifest:

```ts
slug -> {
  observationSource,
  emittedKinds,
  identityRelevantKinds: {
    [kind]: {
      groundingTier,
      canBeUserSubject
    }
  }
}
```

Projection logic reads capabilities. It should not contain source-specific branches such as `if (source === "github")` except inside source reducers/classifiers.

Grounding tier is semantic and kind-level. An integration can emit both strong structural evidence and weak mention evidence.

Full reconciliation of existing vocabularies is a follow-up; the binding rule for new identity evidence is: manifest first, projection second.

## 9. Cutover checklist

After cutover, every active projection-owned identity row is grounded, every legacy direct-write path is blocked for owned keys, and replay converges.

- [ ] Legacy active `employer` rows are retired as `superseded`/`rejected` with reason `identity_projection_cutover`; they are not hard-deleted.
- [ ] `proposeFact` cannot write projection-owned keys after ownership transfer. Assert with tests.
- [ ] `currentCompany = null` is accepted by boss read, briefing, `/settings`, and Replicache DTOs.
- [ ] Replaying the same observations yields the same active `employer` row.
- [ ] `source=user` correction overrides live corporate affiliation.
- [ ] Disconnecting a work account retires the affiliation and falls back to next-best grounding or `null`.
- [ ] Backfill is dry-by-default, idempotent, and has an explicit `--commit`.
- [ ] Eval covers third-party-subject evidence, ungrounded personal account, corporate account, user correction, and disconnect.

## 10. Verification

Use concrete post-cutover checks:

- Work account: `read_user_context.profile.currentCompany === "Oliv AI"` with projection provenance pointing to `user_org_affiliation`.
- Personal account: `read_user_context.profile.currentCompany === null` unless a user-subject grounding observation exists.
- Boss question "what company do I work at?": answer uses grounded value or says not recorded.
- Langfuse `agent:chat` input contains no Weekday/yourelasticdash employer fact.

## Out of scope

- Expanding `fact-policy.ts` into a second identity adjudicator.
- Global ontology enforcement for all non-identity facts.
- Situational-state projection in slice 1a.
- Full integration capability-manifest reconciliation.
- Guessing identity values for profile completeness.
