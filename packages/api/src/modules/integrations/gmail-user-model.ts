import { z } from "zod";

const identifierSchema = z.string().min(1);
const countSchema = z.number().int().nonnegative();

export const gmailObservationCaptureRequestSchema = z
  .object({
    userId: identifierSchema,
    documentIds: z.array(identifierSchema),
  })
  .strict();

export type GmailObservationCaptureRequest = z.infer<typeof gmailObservationCaptureRequestSchema>;

export const gmailObservationCaptureResultSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("captured"),
        documents: countSchema,
        inserted: countSchema,
        deduped: countSchema,
        skipped: countSchema,
        warnings: countSchema,
        errors: countSchema,
        refoldScheduled: z.boolean(),
      })
      .strict(),
    z.object({ status: z.literal("failed") }).strict(),
  ])
  .refine(
    (result) => result.status === "failed" || result.refoldScheduled === result.inserted > 0,
    {
      message: "refoldScheduled must match whether observations were inserted",
      path: ["refoldScheduled"],
    },
  );

export type GmailObservationCaptureResult = z.infer<typeof gmailObservationCaptureResultSchema>;

export const gmailKindRefoldRequestSchema = z
  .object({
    userId: identifierSchema,
  })
  .strict();

export type GmailKindRefoldRequest = z.infer<typeof gmailKindRefoldRequestSchema>;

export const gmailKindRefoldResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("skipped"),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("blocked"),
      reason: z.enum(["logic-drift", "unverifiable-active-run"]),
      activeChecksum: z.string().min(1).optional(),
      recomputedChecksum: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("activated"),
      projectionVersion: countSchema,
      profileCount: countSchema,
      checksum: z.string().min(1),
    })
    .strict(),
]);

export type GmailKindRefoldResult = z.infer<typeof gmailKindRefoldResultSchema>;

export const gmailKindRefoldSweepRequestSchema = z.object({}).strict();

export type GmailKindRefoldSweepRequest = z.infer<typeof gmailKindRefoldSweepRequestSchema>;

export const gmailKindRefoldSweepResultSchema = z.object({ enqueued: countSchema }).strict();

export type GmailKindRefoldSweepResult = z.infer<typeof gmailKindRefoldSweepResultSchema>;

export interface GmailUserModelHandler {
  capture(request: GmailObservationCaptureRequest): Promise<GmailObservationCaptureResult>;
  refold(request: GmailKindRefoldRequest): Promise<GmailKindRefoldResult>;
  sweep(request: GmailKindRefoldSweepRequest): Promise<GmailKindRefoldSweepResult>;
}

export class NoGmailUserModelHandlerRegisteredError extends Error {
  constructor() {
    super("[integrations] no Gmail user-model handler is registered");
    this.name = "NoGmailUserModelHandlerRegisteredError";
  }
}

let gmailUserModelHandler: GmailUserModelHandler | undefined;

/** Register the user-model adapter that runtime composition supplies. */
export function registerGmailUserModelHandler(handler: GmailUserModelHandler): () => void {
  if (gmailUserModelHandler) {
    throw new Error("[integrations] a Gmail user-model handler is already registered");
  }
  gmailUserModelHandler = handler;

  return () => {
    if (gmailUserModelHandler === handler) gmailUserModelHandler = undefined;
  };
}

/** Capture post-insert Gmail observations without exposing user-model internals. */
export async function captureGmailObservations(
  request: unknown,
): Promise<GmailObservationCaptureResult> {
  const parsedRequest = gmailObservationCaptureRequestSchema.parse(request);
  if (!gmailUserModelHandler) throw new NoGmailUserModelHandlerRegisteredError();
  return gmailObservationCaptureResultSchema.parse(
    await gmailUserModelHandler.capture(parsedRequest),
  );
}

/** Run one Gmail kind refold without exposing projection internals. */
export async function refoldGmailKindProjection(request: unknown): Promise<GmailKindRefoldResult> {
  const parsedRequest = gmailKindRefoldRequestSchema.parse(request);
  if (!gmailUserModelHandler) throw new NoGmailUserModelHandlerRegisteredError();
  return gmailKindRefoldResultSchema.parse(await gmailUserModelHandler.refold(parsedRequest));
}

/** Schedule refolds for active Gmail kind projections without exposing their storage. */
export async function scheduleGmailKindRefoldSweep(
  request: unknown,
): Promise<GmailKindRefoldSweepResult> {
  const parsedRequest = gmailKindRefoldSweepRequestSchema.parse(request);
  if (!gmailUserModelHandler) throw new NoGmailUserModelHandlerRegisteredError();
  return gmailKindRefoldSweepResultSchema.parse(await gmailUserModelHandler.sweep(parsedRequest));
}
