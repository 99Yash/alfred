import { z } from "zod";

const identifierSchema = z.string().min(1).max(500);

export const googleColdStartResearchRequestSchema = z
  .object({
    userId: identifierSchema,
    credentialId: identifierSchema,
  })
  .strict();

export type GoogleColdStartResearchRequest = z.infer<typeof googleColdStartResearchRequestSchema>;

export const googleColdStartResearchResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("enqueued") }).strict(),
  z.object({ status: z.literal("duplicate") }).strict(),
]);

export type GoogleColdStartResearchResult = z.infer<typeof googleColdStartResearchResultSchema>;

export type GoogleColdStartResearchHandler = (
  request: GoogleColdStartResearchRequest,
) => Promise<unknown>;

export class NoGoogleColdStartResearchHandlerRegisteredError extends Error {
  constructor() {
    super("[integrations] no Google cold-start research handler is registered");
    this.name = "NoGoogleColdStartResearchHandlerRegisteredError";
  }
}

let googleColdStartResearchHandler: GoogleColdStartResearchHandler | undefined;

/** Register the cold-start adapter that runtime composition supplies. */
export function registerGoogleColdStartResearchHandler(
  handler: GoogleColdStartResearchHandler,
): () => void {
  if (googleColdStartResearchHandler) {
    throw new Error("[integrations] a Google cold-start research handler is already registered");
  }
  googleColdStartResearchHandler = handler;

  return () => {
    if (googleColdStartResearchHandler === handler) {
      googleColdStartResearchHandler = undefined;
    }
  };
}

/** Request cold-start research after Google supplies enough onboarding context. */
export async function requestGoogleColdStartResearch(
  input: unknown,
): Promise<GoogleColdStartResearchResult> {
  const request = googleColdStartResearchRequestSchema.parse(input);
  if (!googleColdStartResearchHandler) {
    throw new NoGoogleColdStartResearchHandlerRegisteredError();
  }

  return googleColdStartResearchResultSchema.parse(await googleColdStartResearchHandler(request));
}
