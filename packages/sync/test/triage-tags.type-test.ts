import type { SyncedTriageTag } from "../src/types";

const base = {
  threadId: "thread_1",
  userId: "user_1",
  category: "fyi" as const,
  documentId: null,
  appliedLabelId: null,
  senderSignificanceBand: null,
  rowVersion: 0,
  updatedAt: null,
};

export const okAuto: SyncedTriageTag = {
  source: "auto",
  confidence: 0.42,
  rationale: "subscribed digest",
  classifiedAt: "2026-06-05T00:00:00.000Z",
  ...base,
};

export const okUser: SyncedTriageTag = {
  source: "user",
  overriddenAt: "2026-06-05T00:00:00.000Z",
  ...base,
};

export const badUserWithConfidence: SyncedTriageTag = {
  source: "user",
  overriddenAt: "2026-06-05T00:00:00.000Z",
  // @ts-expect-error — confidence is absent on the `user` branch
  confidence: 0.9,
  ...base,
};

export const badAutoWithOverriddenAt: SyncedTriageTag = {
  source: "auto",
  confidence: 0.9,
  rationale: null,
  classifiedAt: "2026-06-05T00:00:00.000Z",
  // @ts-expect-error — overriddenAt is absent on the `auto` branch
  overriddenAt: "2026-06-05T00:00:00.000Z",
  ...base,
};

// @ts-expect-error — `confidence`/`rationale`/`classifiedAt` are required on `auto`
export const badAutoMissingProvenance: SyncedTriageTag = {
  source: "auto",
  ...base,
};
