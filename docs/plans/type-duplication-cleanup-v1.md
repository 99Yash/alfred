# Type-duplication cleanup — investigation & plan (v1)

**Date:** 2026-07-08
**Scope:** whole monorepo (`packages/*`, `apps/web`)
**Rule enforced:** [`docs/reference/code-style.md` §1](../reference/code-style.md) — *"Never hand-roll a type that already exists."*
**Method:** five parallel surveys (DB-row dupes, zod-parallel types, web cross-boundary, enum drift, cross-module plain shapes). Every finding below was verified by reading **both** the local shape and its source of truth — not field-name guesses.

---

## TL;DR

The codebase is **already fairly disciplined** here — §1 exists, a prior "June audit" happened, and the big enums / synced entities are correctly single-sourced. This is not a tire-fire; it's a **~24-item drift-mopping pass**, most of them one-liners.

Two framing facts that shape every fix:

1. **The DB exports 65 derived row types** (`Entity`, `Todo`, `UserFact`, …) via `$inferSelect`. Consumers should import the **named type** or `Pick`/`Omit` it — never restate the columns, and prefer `Pick<Entity, …>` over re-spelling `Pick<typeof entities.$inferSelect, …>` (see the convention note below).
2. **There are zero `pgEnum`s.** Every `status`/`kind`/`channel`/`audience` column is `text`. So enums live purely in TS; the canonical home for a cross-boundary one is **`@alfred/contracts`**. Enum duplication is therefore always TS-copy-vs-TS-copy, and the dangerous variant is **drift** (copies that disagree).

### The original example was a red herring (verified)

`ParsedPerson`, `ContactAggregate`, `CorrespondenceStats` in `memory/team-graph.ts` are **legit-local, not duplicates**:

- `ParsedPerson` — a per-token parse DTO, declared once, different field names than `extractSenderContext`'s `SenderContextResult` (`address`/`domain` vs `senderAddress`/`senderDomain`). The persisted side is `entities.metadata`, an **untyped `jsonb` → `unknown`**, so there is *no row type to derive from*.
- `CorrespondenceStats` — already the exemplary pattern: `z.infer<typeof correspondenceStatsSchema>`, single source, imported by both consumers.
- `ContactAggregate` — a scan accumulator (counters + timestamps), declared once, imported only by its test. Nothing to derive from.

The instinct ("extract these from DB types") doesn't apply where the storage is untyped jsonb. The real wins are elsewhere — below.

---

## Findings, batched by ROI

Confidence: **H** = verified byte-identical / trivial · **M** = correct fix, minor reshape · **L** = hygiene / low blast radius.

### Batch 1 — Trivial one-liners, canonical already imported in the same file (do first)

| # | Location | Problem | Fix | Conf |
|---|---|---|---|---|
| 1 | `packages/api/src/modules/memory/entities.ts:11` | `z.enum(["person",…,"other"])` re-inlined; file **already imports** `entityKindSchema` (line 5) and uses it at line 47 | `kind: entityKindSchema,` | H |
| 2 | `packages/api/src/modules/memory/chunks.ts:19` | `z.enum(["thread_summary",…])` re-inlined; file **already imports** `memoryChunkKindSchema` (line 12) and uses it at line 47 | `kind: memoryChunkKindSchema,` | H |
| 3 | `packages/api/src/modules/memory/user-context.ts:130` | `type EntityRow = {id;kind;canonicalName;aliases:unknown;metadata:unknown}` — raw literal | `type EntityRow = Pick<Entity, "id"\|"kind"\|"canonicalName"\|"aliases"\|"metadata">` (named export; also switched sibling `FactContextRow` → `Pick<UserFact, …>`) | H |
| 4 | `packages/api/src/modules/briefing/gather.ts:792` | `interface WeatherLocation {lat;lng;label}` — byte-identical to contracts `WeatherFallbackLocation`; already interoperate via `weatherFallbackFor` | Delete local; `import type { WeatherFallbackLocation } from "@alfred/contracts"` (rename in contracts if the `Fallback` name grates) | H |
| 5 | `packages/api/src/modules/user-model/affiliation.ts:51` | `type OrgAffiliationStatus = "connected"\|"disconnected"` copies the inline enum in `userOrgAffiliationPayloadSchema`; file already imports `UserOrgAffiliationPayload` | `type OrgAffiliationStatus = UserOrgAffiliationPayload["status"]` | M |

### Convention: prefer the named row-type export over inline `typeof table.$inferSelect`

Established pattern, confirmed by the numbers: **59 tables, 65 named `$inferSelect` exports** — SELECT row types are named-and-exported for essentially every table (`Entity`, `Document`, `UserFact`, `ChatAttachment`, … all re-exported from `@alfred/db/schemas`). Only **7 sites** in all of `api`+`web` re-spell `typeof X.$inferSelect` inline; that's the deviation, not the norm. `Pick<Entity, …>` is preferred over `Pick<typeof entities.$inferSelect, …>` — identical type, but it uses the canonical name and lets a type-only consumer `import type { Entity }` instead of pulling the table *value* into scope just to read its inferred type. (Batch 1 fixed both re-spells in `user-context.ts`.)

Remaining SELECT re-spells to switch to the named type (low-risk, fold into a later batch):
- `packages/api/src/modules/memory/fact-policy.ts:212` → `Document`
- `packages/api/src/modules/chat/index.ts:58,62` → `ChatAttachment`

**The actual gap is INSERT types.** Only **3** `New*` exports exist (`NewArtifact`, `NewBriefing`, `NewIntegrationObject`) out of 59 tables — so `$inferInsert` re-spelling is *not* an established-pattern violation, there's simply no named type to import:
- `packages/api/src/modules/chat/attachments.ts:185` and `chat/index.ts:56` re-spell `typeof chatAttachments.$inferInsert` because no `NewChatAttachment` exists.

Recommendation: add `New*` insert exports **on demand** (i.e. export `NewChatAttachment` when we touch the chat-attachment sites in Batch 4), not speculatively for all 59 tables. Deciding whether §1 of `code-style.md` should also be updated to teach the named-export-first form (its current example uses the inline `typeof documents.$inferSelect`) is a separate doc change worth making.

### Batch 2 — Web: derive from Eden / `@alfred/sync` (all type-only, boundary-safe)

`apps/web` cannot import server packages at runtime, but `check-web-boundaries.mjs` only flags **runtime** bindings — `import type` and Eden `ReturnType` inference are sanctioned (`eden.ts` already `import type { App }`). Several of these also delete `res.data as X` casts that actively *defeat* inference.

| # | Location | Problem | Fix | Conf |
|---|---|---|---|---|
| 6 | `apps/web/src/hooks/use-meetings.ts:48` | `interface MeetingResponseItem` = Eden `me.meetings` item (`MeMeetingItem`, `me/routes.ts:178`); line 26 casts, defeating inference | Delete interface + cast; `type … = NonNullable<Awaited<ReturnType<typeof client.api.me.meetings.get>>["data"]>["items"][number]` | H |
| 7 | `apps/web/src/hooks/use-inbox.ts:234` | `interface InboxResponseItem` = Eden `me.inbox` item (`MeInboxItem`, `me/routes.ts:96`) | Type `toInboxItem`'s `row` param from the inferred element; delete interface | H |
| 8 | `apps/web/src/hooks/use-latest-briefing.ts:12` | `interface LatestBriefingSummary` = Eden `me.briefings.latest` (`MeLatestBriefing`, `me/routes.ts:169`) | Derive via `ReturnType` of the `.get` | H |
| 9 | `apps/web/src/hooks/use-run-briefing.ts:15` | `interface RunBriefingResult` — flattened hand-type **loses the discriminated union**; line 29 casts | Derive from `me.briefings.run.post`; drop the cast | M/H |
| 10 | `apps/web/src/hooks/use-inbox.ts:155` | `interface InboxAttachment` = Eden inbox-detail attachment (`MeInboxAttachment`, `me/routes.ts:161`); mapper is 1:1 | Derive mapper output from inferred element | M |
| 11 | `apps/web/src/hooks/use-tool-tiers.ts:5` | `interface RiskTierCounts {no_risk;low;medium;high}` — server's is literally `Record<ToolRiskTier, number>` | `type RiskTierCounts = Record<ToolRiskTier, number>` (`ToolRiskTier` from `@alfred/contracts`); keep the runtime guard | M/L |
| 12 | `apps/web/src/lib/replicache/{use-briefings.ts:7,use-workflows.ts:12,use-chat.ts:15}` | `interface ReplicacheSnapshot<T>` declared **3× identically** | Hoist to `lib/replicache/client.ts`, import in all three | M/L |
| 13 | `apps/web/src/lib/chat/use-chat-stream.ts:19` | `interface StreamingNarration {index;text}` = `SyncedChatNarration` (`@alfred/sync`) exactly | `import type { SyncedChatNarration }`; keep sibling `StreamingToolCall`/`StreamingMessage` (they deliberately diverge) | L |

### Batch 3 — Small enums: single-source them (api-internal)

| # | Location | Problem | Fix | Conf |
|---|---|---|---|---|
| 14 | `packages/api/src/modules/triage/sender-priors.ts:27` | local `interface SenderPrior` **name-collides** with the DB-exported `SenderPrior` (`db/schema/sender-priors.ts:49`) | `type SenderPrior = Pick<typeof senderPriors.$inferSelect, "categoryCounts"\|"lastCategory">` (`categoryCounts` is `jsonb.$type<Record<string,number>>` — exact) | H |
| 15 | `packages/api/src/modules/scratchpad/index.ts:32,55,77` | `["shared","scratch"]` declared **4×**; contracts has the inline `ScratchEntry.zone` but no exported const | Add `export const SCRATCH_ZONES = ["shared","scratch"] as const` + `type ScratchZone` in `contracts/runtime.ts`; api uses both | M/L |
| 16 | `packages/api/src/modules/triage/{sender-kind.ts:15,18,sender-extraction-event.ts:41}` | triage-demoting `["group","service"]` (a 2-member subset of `EntityNodeKind`) declared **3×** | Export one `TRIAGE_DEMOTING_ENTITY_KINDS` const + type from `sender-kind.ts`; downstream uses `TriageSenderKindSignal["kind"]` | M/L |
| 17 | `packages/api/src/modules/triage/deepen.ts:44` · `packages/contracts/src/triage.ts:223` | intra-file: a hand-typed union next to its own plain `z.enum` (`deepenOutputSchema` :56; `senderContextSchema` bodyActor :235) | `z.infer` the field from the schema | L |

### Batch 4 — Cross-module plain-shape dedup

| # | Location | Problem | Fix | Conf |
|---|---|---|---|---|
| 18 | `packages/api/src/modules/chat/attachments.ts:21` vs `chat/index.ts:65` | `AttachmentInput` ≈ `FreshAttachmentDescriptor`, differ only by `position` optionality | Reuse `AttachmentInput` in `index.ts` (make `position?` on the canonical type) | M |
| 19 | `packages/api/src/modules/agent/service.ts:32` vs `user-model/observations.ts:27` | `PgErrorLike` pg-error narrowing shape declared twice (one a strict subset) | Define one superset `{code?;constraint?;message?;cause?}` in a small `lib/pg-errors.ts`; import in both. **Keep the explicit structural walk** — do *not* switch to `isRecord` (per package CLAUDE.md) | M |
| 20 | `packages/api/src/modules/briefing/compose.ts:79` vs `skill-documentation/email.ts:37` | `{subject;html;text}` composed-email shape declared twice | Introduce shared `ComposedEmail` in `@alfred/mailer`; both return it (note: `RenderedBriefingEmail` at `briefing/references.ts:35` is a 2-field variant — leave it) | L |

### Batch 5 — Structural (revised after verification; DONE 2026-07-09)

**Correction on execution.** Reading both sides of each pair (not just field names) reversed the original prescription for both items — all three target surfaces turned out to be preview/stub/showcase code, and the fixes below would have introduced bugs if applied as first written. What actually shipped:

| # | Location | Verified reality | Fix applied | Conf |
|---|---|---|---|---|
| 21 | `apps/web/src/routes/-memory/helpers.ts:1` | Web's `"proposed"\|"confirmed"` mirrors the **2-member wire subset** (`syncedFactSchema.status`, `sync/src/schemas.ts:171`), **not** the api's 5-member internal lifecycle. `@alfred/sync` already owns that enum and web can import it. Relocating the 5-member set to contracts + importing it into web would have let the stub represent states (`rejected`/`edited`/`superseded`) that never sync. `-memory` is a stub (Replicache subscribe stubbed; `useState<LocalFact[]>([])`). | `type FactStatus = SyncedFact["status"]` from `@alfred/sync` — derive from the wire truth, no contracts move. | H |
| 22 | `apps/web/.../dimension-chat-thread.tsx:59` & `lib/artifacts/library-artifacts.ts:3` | **Both are view-models, not drifted mirrors.** `ArtifactType` (`presentation\|document\|spreadsheet\|pdf`) is a **Library display taxonomy** used by 5 files — `presentation`/`pdf` are formats, not storage kinds; aligning it to `artifactKindValues` (`document/pages/spreadsheet`) would break the Library type filter. `ArtifactPreviewState` (`completed\|generating\|empty`) is consumed **only by the styleguide** as a demo-state selector — `empty` has no lifecycle analog. | **Reclassified as carve-outs.** Added a one-line "why not derived" comment to each (per §1). Did **not** align them. | H |

The 5-member `factStatusSchema` → `@alfred/contracts` relocation (single-sourcing the api↔sync duplication) was considered and **deferred**: it fixes an api-internal + wire duplication, not the web consumer, and both sides are low-churn. Revisit if a third boundary needs the full set. See carve-out note below.

### Batch 6 — Script hygiene (lowest priority)

| # | Location | Problem | Fix | Conf |
|---|---|---|---|---|
| 23 | `packages/ai/src/scripts/verify-capabilities.ts:33,38` | `ReasoningOption` / `SnapshotCapabilities` hand-rolled above their plain `z.object` schemas | `z.infer` — **caveat:** schemas use `.passthrough()`, so `z.infer` adds an index signature (harmless; call sites only read named fields). Accept the widening or drop `.passthrough()` | H |

---

## Carve-outs — verified correct, do NOT "fix" these

Re-flagging these would be a regression. Recorded so the next pass doesn't re-litigate them.

- **Interface-first schemas** (`z.object({…}) satisfies z.ZodType<Foo>` / `const s: z.ZodType<Foo> = …`): the whole `contracts/briefing.ts` contribution family, `senderContextSchema`, `jsonValueSchema`. The interface is the source; `z.infer` there is a **TS2456 circular ref**.
- **jsonb → `unknown` narrowing mappers**: `rowToEntity`/`rowToChunk`/`rowToProfile`/`rowToPref` restate the jsonb column on purpose (untyped jsonb is `unknown`; the mapped output *is* the contract). `MemoryChunkRow` (`chunks.ts:33`) and `EntityRow` (`entities.ts:34`) are correct `Omit<Row,…> & {…}` reshapes.
- **Nullability narrowed behind a guard**: `DueRow.nextRunAt`, `RecentRejection.decidedAt` — deriving re-adds `| null` and breaks the non-null guarantee.
- **snake_case raw-pg results**: `OutboxRow` (`outbox-relay.ts`) uses `user_id`/`created_at` + `id: string` (bigserial-as-string) — deriving from `$inferSelect` gives the wrong names/types.
- **Wire/DTO reshapes**: `Synced*`, the `Me*` route DTOs, `EmailListRow` join projections, web view-models (`InboxMessage`/`InboxThread`, `-preview-chat` fixtures), streaming shapes (`StreamingToolCall`/`StreamingMessage`) — divergence is the point.
- **The team-graph trio** (`ParsedPerson`/`ContactAggregate`/`CorrespondenceStats`) — see TL;DR.
- **`library-artifacts.ts` `ArtifactType`** — a Library display taxonomy (`presentation`/`pdf` are formats, not storage kinds), not the contracts `ArtifactKind`. Aligning it breaks the type filter. **`dimension-chat-thread.tsx` `ArtifactPreviewState`** — a styleguide-only demo-state selector (`empty` has no lifecycle analog), not the contracts `ArtifactStatus`. Both now carry a "why not derived" comment (Batch 5, corrected).

---

## Suggested execution

- **PR 1 — Batch 1 (5 one-liners).** Zero-risk, canonical already in-file. `pnpm check-types` is the whole test.
- **PR 2 — Batch 2 (web Eden/sync derives).** Type-only; removes 3 inference-defeating casts. Run `pnpm check:web-boundaries` + `pnpm check-types`.
- **PR 3 — Batches 3 & 4 (api enum/shape single-sourcing).** A couple of new small consts/types.
- **PR 4 — Batch 5 (DONE, revised).** No package move after all: web `-memory` fact-status derives from `SyncedFact["status"]`; the two artifact fixtures are carve-outs (comment-only). See the revised Batch 5 table for why the original relocate/align prescription was reversed.
- **Batch 6** — fold into any `packages/ai` PR; not worth its own.

After each derive lands, drop now-orphaned imports (`noUnusedLocals` will fail otherwise) and run scoped `oxfmt` only on touched files (never a tree-wide format — see `.lessons/use-oxfmt-oxlint-never-biome.md`).

## Coverage & gaps (honest)

- Surveyed every `interface`/`type` under `packages/{api,ai,contracts}/src` and `apps/web/src`, every `z.enum`/`as const`, every `*Schema` const cross-checked against hand-rolled type names.
- **Not exhaustively covered:** `apps/server`, test/eval fixtures, pure-cosmetic UI unions (`"sm"|"md"`, tones/variants — out of scope by design), and shape pairs that differ by ≥2 fields (the exact-field-set matcher misses those). `@alfred/db`'s own `ModelsDevReasoningOption` (parallels a fetch shape) was outside the audited packages.
- Enum **drift** (sets that disagree) was treated as highest-severity; the only two found are #21/#22, both preview-scoped today.
