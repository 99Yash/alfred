/**
 * Compile-time proof that the `SyncedTriageTag` discriminated union makes the
 * Phase-0 illegal states unrepresentable (rfc-triage-tags.md, Invariants 3 & 4).
 * This file has no runtime behavior — it exists so `tsc` fails if the union
 * ever loosens. The `@ts-expect-error` lines MUST error; if one stops erroring,
 * tsc reports the unused directive and the build breaks.
 */
import type { SyncedTriageTag } from "./types";

const base = {
  threadId: "thread_1",
  userId: "user_1",
  category: "fyi" as const,
  documentId: null,
  appliedLabelId: null,
  rowVersion: 0,
  updatedAt: null,
};

// ✅ legal: an auto tag carries classifier provenance.
export const okAuto: SyncedTriageTag = {
  source: "auto",
  confidence: 0.42,
  rationale: "subscribed digest",
  classifiedAt: "2026-06-05T00:00:00.000Z",
  ...base,
};

// ✅ legal: a user tag carries overriddenAt and no provenance.
export const okUser: SyncedTriageTag = {
  source: "user",
  overriddenAt: "2026-06-05T00:00:00.000Z",
  ...base,
};

// ❌ a user tag must NOT carry a confidence score (Invariant 3).
export const badUserWithConfidence: SyncedTriageTag = {
  source: "user",
  overriddenAt: "2026-06-05T00:00:00.000Z",
  // @ts-expect-error — confidence is absent on the `user` branch
  confidence: 0.9,
  ...base,
};

// ❌ an auto tag must NOT carry overriddenAt (Invariant 4).
export const badAutoWithOverriddenAt: SyncedTriageTag = {
  source: "auto",
  confidence: 0.9,
  rationale: null,
  classifiedAt: "2026-06-05T00:00:00.000Z",
  // @ts-expect-error — overriddenAt is absent on the `auto` branch
  overriddenAt: "2026-06-05T00:00:00.000Z",
  ...base,
};

// ❌ an auto tag is missing required provenance.
// @ts-expect-error — `confidence`/`rationale`/`classifiedAt` are required on `auto`
export const badAutoMissingProvenance: SyncedTriageTag = {
  source: "auto",
  ...base,
};
