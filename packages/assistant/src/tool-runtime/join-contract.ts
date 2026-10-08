import { z } from "zod";

/** The join arm reads `childRunId` off a `staging: "join"` call, without the tool's `execute`. */
export const joinToolInput = z.object({ childRunId: z.string().min(1) });
