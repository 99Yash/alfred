# User-model P1 Gmail shadow

**Status:** PRs A-I built and on `main` (classifier, kind fold, projection
script, live observation capture, triage consumer override). **First activation
still pending** (manual) — see the
[activation runbook](../reference/user-model-gmail-projection-activation.md).
PR J (scheduled re-fold) not built.
**Epic:** #218 evolving user-model spine.
**Parent:** ADR-0067 / [multi-source-user-model-v1.md](./multi-source-user-model-v1.md).

P1 is the first real replay over the ADR-0067 substrate. It is **not** a
reducer-only slice. It is a full Gmail shadow build: fill Gmail history,
reduce `documents` into `observations`, fold observations into the stable entity
layer plus versioned projections, validate determinism and known bad cases, then
optionally activate the projection. Consumers do not cut over in this slice.

## Locked decisions

- **Shadow-only until validation.** P1 may write observation rows and projection
  rows, but no triage/briefing/meeting-prep consumer reads them until replay
  determinism and spot checks pass.
- **Full-fidelity is the default.** Gmail API calls, embeddings, and storage are
  cheap at current scale. Do not create reduced-fidelity ingestion paths merely
  to save cost.
- **The fold is pure over stored inputs.** Live Gmail repair does not happen
  inside the fold. If a repair is needed, run a separate committed preflight that
  updates/persists `documents`, then replay.
- **Deterministic core, nondeterministic edges.** Reducers, classifiers, folds,
  checksums, and activation gates are deterministic. Web/LLM enrichment only
  improves uncertain candidates after the deterministic projection has surfaced
  them.
- **All identities get stable nodes.** `person`, `organization`, `group`,
  `service`, `repository`, `project`, and `unknown` identities are all real
  stable nodes. Person scoring is gated by the versioned profile kind, not by
  whether a node exists.
- **No name-only stable identities.** Display names inform labels and weak
  classifier evidence, but do not mint or merge stable nodes without a hard
  identity such as email.

## Current data read

Production read-only check on 2026-06-30:

| Metric                               |         Count |
| ------------------------------------ | ------------: |
| Gmail `documents`                    |         1,788 |
| `yash.k@oliv.ai` Gmail docs          |           857 |
| Personal Gmail docs                  |           931 |
| Raw header coverage                  | 1,788 / 1,788 |
| `List-Id` headers                    |           887 |
| `Precedence` headers                 |           867 |
| `In-Reply-To` / `References` headers |           532 |
| `Reply-To` headers                   |         1,189 |
| `documents` table size               |         43 MB |
| DB size                              |        124 MB |

The data is small enough that the design should optimize for correctness and
replay quality, not API/storage thrift.

## Build slices

### PR A: contract and schema rails ✅ BUILT 2026-06-30

1. Add `unknown` to `ENTITY_NODE_KINDS`.
2. Add `unknown` to `NON_PERSON_ENTITY_KINDS`.
3. Keep `isPersonScorable(kind)` as `kind === "person"`.
4. Add typed projection provenance contracts for classifier output:
   - `classification.kind`
   - `classification.confidence`
   - `classification.bestGuess`
   - `classification.evidenceCodes`
   - `classification.researchStatus`
5. Add active SQL views:
   - `active_entity_profiles`
   - `active_entity_edges`
   - `active_entity_co_occurrence`

The views pin rows by `active_projection_versions.active_run_id =
projection_run_id`, matching `userModelReader`. They are used by validation and
later consumer cutover.

### PR B: Gmail preflight and sent backfill ✅ BUILT 2026-06-30

Add `apps/server/src/scripts/backfill-gmail-sent-committed.ts`.

Contract:

- Dry-run by default; `--commit` required to write.
- Requires `--emails` or `--all-connected`.
- Supports `--query`, `--newer-than`, `--max-messages`, `--page-size`.
- Calls the existing full Gmail ingest path with `triageInsertedDocs: false`.
- Persists sent docs as normal `documents` with `metadata.isSent=true`.
- Never emits triage events and never mutates Gmail labels.
- Does not pull Alfred-authored outbound mail: Alfred's own messages are sent
  through Resend/SMTP and are not written into the user's Gmail Sent folder.
- Reports fetched/inserted/skipped/ignored/errors/sent/inbound/chunks.

Default query should cover the app lifetime for now, e.g. `newer_than:180d
in:sent`, but the horizon is a script argument rather than an architecture
constant.

### PR C: Gmail reducer ✅ BUILT 2026-06-30

Add a pure reducer under `packages/api/src/modules/user-model/gmail-reducer.ts`
or a sibling reducer folder if the registry lands in the same PR.

```ts
export interface GmailDocumentForReduction {
  readonly id: string;
  readonly userId: string;
  readonly sourceId: string;
  readonly sourceThreadId: string | null;
  readonly accountId: string | null;
  readonly title: string | null;
  readonly authoredAt: Date | null;
  readonly raw: unknown;
  readonly metadata: unknown;
}

export interface GmailReductionIssue {
  readonly documentId: string;
  readonly severity: "skip" | "warn";
  readonly code: string;
  readonly message: string;
}

export interface GmailReductionResult {
  readonly observations: ObservationInsertInput[];
  readonly issues: GmailReductionIssue[];
}

export function reduceGmailDocument(row: GmailDocumentForReduction): GmailReductionResult;
```

Reducer rules:

- Input is stored `documents` only.
- One Gmail message produces one `email_message` observation.
- `familyKey = gmail:message:<accountId>:<gmailMessageId>`.
- `subjectIdentity` is the initiating sender identity:
  - inbound: `From`
  - sent: the user's sending address from `From`
- `objectIdentity` is `null` in P1.
- Participants include parseable `from`, `to`, `cc`, `bcc` addresses with roles.
- Stable participant identities are email-only.
- Display names are stored as participant `displayName` / `raw`, never as
  stable identities.
- `participants.recipientCount` counts distinct To/Cc/Bcc recipient identities.
- `participants.listId` is populated from `List-Id` when present.
- Reducer skips rows with no parseable sender and records a reducer issue.
- Reducer never classifies kind or significance.

Payload shape:

```ts
interface GmailEmailMessagePayload {
  provider: "gmail";
  documentId: string;
  messageId: string;
  threadId: string | null;
  accountId: string | null;
  isSent: boolean;
  subject: string | null;
  subjectHash: string | null;
  headers: {
    messageId: string | null;
    inReplyTo: string | null;
    references: string[];
    listId: string | null;
    replyTo: string | null;
    deliveredTo: string | null;
    autoSubmitted: string | null;
    precedence: string | null;
  };
}
```

Use a zod schema for this payload. Add it to `observationInsertSchema`'s
kind-specific payload validation for `kind === "email_message"`.

Evidence hash covers only relationship-significant fields:

- canonical participants and roles
- distinct recipient count
- `isSent`
- `occurredAt`
- `List-Id`
- reply/reference headers used by the fold

### PR D: reducer backfill ✅ BUILT 2026-06-30

Add `apps/server/src/scripts/backfill-gmail-observations-committed.ts`.

Contract:

- Dry-run by default; `--commit` required.
- Requires `--emails` or `--all-connected`.
- Filters `documents.source='gmail'`.
- Supports `--since`, `--until`, `--limit`, `--force`.
- Orders deterministically by `authoredAt nulls last, id`.
- Reduces documents through `reduceGmailDocument`.
- Writes through `insertObservation`.
- Handles family supersession with a shared helper:

```ts
async function appendObservationFamilyMember(input: ObservationInsertInput, tx: DbExecutor);
```

That helper owns:

- loading current family head
- setting `supersedesObservationId`
- retrying no-fork/single-root conflicts
- returning inserted/deduped/skipped status

Do not make each provider reinvent the CAS loop.

### PR E: deterministic profile classifier ✅ BUILT

`packages/api/src/modules/user-model/entity-kind-classifier.ts`.


Add a deterministic classifier used only by the fold:

```ts
export interface EntityKindClassification {
  readonly kind: EntityNodeKind;
  readonly confidence: number;
  readonly bestGuess?: Exclude<EntityNodeKind, "unknown">;
  readonly evidenceCodes: string[];
}

export function classifyEntityKind(input: {
  readonly identity: IdentityRef;
  readonly displayNames: readonly string[];
  readonly observations: readonly Observation[];
  readonly payloadSignals: readonly GmailPayloadSignals[];
}): EntityKindClassification;
```

P1 policy:

- `group` for `List-Id`, list precedence, strong list display names, group-style
  addresses such as `engineering@`, `team@`, `all@`.
- `service` for `noreply`, `notifications`, alerts, billing, security, provider
  service domains, GitHub/Vercel/Railway/Sentry/Linear notification senders.
- `organization` for domain-like org nodes, not normal sender emails.
- `person` only for individual-looking mailboxes with no list/service evidence.
- `unknown` when confidence is below the person/group/service/org threshold.

`unknown` is non-person-scorable. If enrichment later confirms a person, replay
into a new projection version changes `entity_profiles.kind`; stable IDs do not
change.

### PR F: Gmail fold ✅ BUILT (kind-only subset)

`packages/api/src/modules/user-model/gmail-kind-fold.ts`. This slice writes the
`entity_profiles.kind` + classifier provenance subset only; significance, edges,
co-occurrence, and reciprocity remain deferred as designed below.


Add a projection runner, likely under
`packages/api/src/modules/user-model/fold/`.

Input:

- active Gmail family-head observations only, ordered by `occurredAt asc, id asc`
- current projection run metadata
- `ENTITY_ID_NAMESPACE` required

Output:

- stable `entity_nodes`
- stable `entity_identities`
- versioned `entity_profiles`
- versioned `entity_edges`
- versioned `entity_co_occurrence`
- projection cursor and checksum

Fold rules:

- Ensure stable nodes for every participant identity.
- Record `entity_identities` for every participant identity.
- Classify profile kind deterministically.
- Never score `unknown`, `group`, `service`, `organization`, `repository`, or
  `project` as people.
- Person-person co-occurrence only includes pairs where both profiles are
  `person` above threshold.
- Events with `fanOut > FAN_OUT_CUTOFF` contribute zero pair co-occurrence.
- Gmail message-grain family keys count observations and event families. They
  are the right grain for idempotent supersession, but not sufficient as a
  promotion-diversity signal because one long Gmail thread can contain many
  messages/families. Gmail promotion therefore also requires distinct thread
  diversity.
- `frequent_collaborator` promotion requires:
  - `weight >= PROMOTION_THRESHOLD`
  - `observationCount >= PROMOTION_MIN_OBSERVATIONS`
  - `familyCount >= PROMOTION_MIN_FAMILIES`
  - Gmail `threadCount >= 2`
- The user's own email identity may be minted as a stable node for reply
  latency and reciprocity accounting, but self is excluded from person
  significance rankings and `frequent_collaborator` surfacing.
- Do not assert `works_at` from email domain alone.
- Use email domain for `sameOrg` and optional `in_org` context.
- Compute reply latency and reciprocity in P1 using sent + inbound docs:
  - alternating inbound/outbound messages in the same thread
  - weekend/off-hours normalized by user timezone
  - aggregate buckets/components only, not unbounded samples

`entity_profiles.provenance` should include classifier evidence, top source
observation ids/family keys, and research status. It should not include raw
email body content.

### PR G: projection run script and validation ✅ BUILT

`apps/server/src/scripts/project-user-model-gmail-shadow-committed.ts`. Local
gate validation lives in
`packages/api/test/user-model/gmail-kind-projection-gates.test.ts`; prod
activation is documented in the
[activation runbook](../reference/user-model-gmail-projection-activation.md).


Add `apps/server/src/scripts/project-user-model-gmail-shadow-committed.ts`.

Contract:

- Dry-run by default; `--commit` writes rows.
- Does not activate by default.
- Requires explicit projection version.
- Clears rows for a reused non-completed run before re-projecting.
- Completes run with checksum, row counts, and source high watermark.
- Optional `--activate` is refused unless validation gates pass or `--force` is
  present with a printed warning.

Validation gates:

1. Replay same input twice and checksums match.
2. Observation count equals reducer-eligible Gmail documents minus skips.
3. Header coverage diagnostics report no unexpected systematic drops.
4. `engineering@oliv.ai` / similar list aliases classify as `group` or
   `unknown`, never person-scored.
5. `noreply` / notification senders classify as `service` or `unknown`, never
   person-scored.
6. Top person-scored profiles exclude lists/services.
7. Legacy graph comparison is coverage-only: expected identities accounted for,
   not legacy ranking parity.
8. Reply/reciprocity samples are plausible on manually inspected threads.
9. Activation helper refuses non-`completed` runs.
10. Active views return the same rows as `userModelReader` after activation in a
    local/dev rehearsal.

## Integration-agnostic API target

Gmail should not define one-off concepts that future reducers cannot use. The
source abstraction should be:

```ts
interface SourceFeed<C> {
  readonly source: ObservationSource;
  page(cursor: C | null): Promise<{
    rows: readonly unknown[];
    nextCursor: C | null;
    highWatermark: ProjectionCursorValue;
  }>;
}

interface SourceReducer<Row> {
  readonly source: ObservationSource;
  reduce(row: Row): ReductionResult;
}

interface ReductionResult {
  readonly observations: readonly ObservationInsertInput[];
  readonly issues: readonly ReductionIssue[];
}
```

Provider-specific code owns raw parsing and observation emission. Generic code
owns validation, append/supersession, projection lifecycle, checksums, active
views, and validation reporting.

## Later source order

1. **Gmail P1.** Proves the full log/fold/cutover path on available data.
2. **GitHub P2.** Replay `webhook_events`; add PR/review/push reducers, commit
   author email bridges, and stable entity IDs in `integration_object_relations`.
3. **Calendar + Directory P3.** Add calendar event feed/backfill and optional
   Workspace Directory identity grounding.
4. **Long-tail integrations.** ClickUp, Notion, Railway, and Vercel only after
   each has a durable replayable feed and a clear relationship signal.

The API should make these sources easy to add, but P1 should not ship all
reducers at once. Validation is much cleaner when one source lands at a time.

## Non-goals

- No consumer cutover.
- No LLM/web enrichment execution.
- No name-only entity creation.
- No thread entities.
- No `works_at` assertion from email domain alone.
- No live Gmail calls inside the fold.
- No raw projection-table reads from consumers.
