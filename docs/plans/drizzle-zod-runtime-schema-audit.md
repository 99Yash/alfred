# Drizzle–Zod runtime-schema audit

**Date:** 2026-07-11
**Scope:** runtime Zod validators that sit directly in front of database writes

## Decision

Generate a Zod base from Drizzle only when the runtime value represents the
same persistence shape. Keep command, wire, sync, job, workflow-state, model,
and external-provider schemas at their owning boundary even when some fields
overlap a table.

The audit inspected every API module that both declares an args schema and
performs an insert/update. It also checked `@alfred/sync` schemas against their
corresponding tables because those are the largest apparent row duplicates.

## Derived persistence boundaries

| Boundary             | Result                                 | Reason                                                                                                      |
| -------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Set preference       | Derived from `user_preferences` insert | Direct insert subset; contract schema overrides the `source` JSONB payload                                  |
| Propose fact         | Derived from `user_facts` insert       | Direct insert subset; confidence clamping and fact-policy-owned `unknown` value remain boundary refinements |
| Upsert style profile | Derived from `style_profiles` insert   | Direct insert/update subset; enum, length, range, and JSON-array rules remain boundary refinements          |

Each derived boundary carries a compile-time `ZodType<Pick<NewRow, …>>`
compatibility check. Runtime tests cover database-managed omissions,
nullability, boundary refinements, JSONB overrides, and transforms.

## Intentional carve-outs

| Boundary family                          | Why it remains independently owned                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Entity upsert/link commands              | They merge aliases/metadata and encode graph operations, not raw inserts; every exposed field has command-specific semantics   |
| Memory-chunk write command               | It computes `contentHash`, deliberately omits `embedding`, and owns content/kind/source rules                                  |
| Standing-instruction commands            | They project a directive into a `user_facts` row; the command shape is not a fact insert                                       |
| Fact edit/supersede/reject commands      | They identify and transition existing rows and create replacement/audit rows internally                                        |
| Todo resolution and chat/agent workflows | Their schemas describe operations or durable workflow state, not table rows                                                    |
| Queue payloads and external/LLM outputs  | Their source of truth is the queue/provider/model protocol                                                                     |
| `@alfred/sync` and Replicache mutators   | Browser-safe wire contracts intentionally select, serialize, rename, or narrow database values; web cannot import `@alfred/db` |

No complete-row select validator or generic update validator currently mirrors
a Drizzle table at an untrusted runtime boundary. Adding generated schemas for
all tables speculatively would increase runtime coupling without removing a
duplicate validator, so schemas are added on demand.

## Follow-up trigger

Revisit a carve-out only when a new validator is a direct persistence mirror.
At that point derive it with `createSelectSchema`, `createInsertSchema`, or
`createUpdateSchema`, then layer `.pick()`/`.omit()` and semantic refinements at
the owning boundary.
