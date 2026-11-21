import { z } from "zod";

const sentDate = z.coerce.date().nullable();

/** The mail facts for one address, from the activity record (ADR-0127). */
export const correspondentHistorySchema = z.object({
  address: z.string(),
  displayName: z.string().nullable(),
  firstSeenAt: sentDate,
  lastSeenAt: sentDate,
  receivedCount: z.int().nonnegative(),
  lastReceivedAt: sentDate,
  sentCount: z.int().nonnegative(),
  lastSentAt: sentDate,
  windowStartedAt: sentDate,
});

export type CorrespondentHistory = z.infer<typeof correspondentHistorySchema>;
