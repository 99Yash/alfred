import { z } from "zod";

export const actionStagingStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "executed",
  "failed",
]);
export const ACTION_STAGING_STATUSES = Object.freeze([...actionStagingStatusSchema.options]);
export type ActionStagingStatus = z.infer<typeof actionStagingStatusSchema>;
