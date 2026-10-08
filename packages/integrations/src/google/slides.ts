import { z } from "zod";
import type { RetryPolicy } from "../shared/retry";
import { googleJson } from "./http";

/**
 * Slides v1 client: create, fetch, and raw `batchUpdate`, through which almost every edit goes.
 * Callers pass a token from `getFreshAccessToken(credentialId)`.
 */

const API_BASE = "https://slides.googleapis.com/v1/presentations";

const createPresentationResponseSchema = z.object({
  presentationId: z.string(),
  title: z.string().optional(),
  revisionId: z.string().optional(),
});

const presentationSchema = z.object({
  presentationId: z.string(),
  title: z.string().optional(),
  revisionId: z.string().optional(),
  /** Loose; callers that need structure parse further. */
  slides: z.array(z.unknown()).optional(),
});

const batchUpdateResponseSchema = z.object({
  presentationId: z.string().optional(),
  replies: z.array(z.unknown()).optional(),
});

export interface CreatePresentationArgs {
  accessToken: string;
  title: string;
}

export interface CreatePresentationResult {
  presentationId: string;
  title?: string | undefined;
}

/** Lands in the Drive root. */
export async function createPresentation(
  args: CreatePresentationArgs,
): Promise<CreatePresentationResult> {
  const parsed = await sendJson(
    createPresentationResponseSchema,
    "POST",
    API_BASE,
    args.accessToken,
    {
      title: args.title,
    },
  );

  return { presentationId: parsed.presentationId, title: parsed.title };
}

export interface GetPresentationArgs {
  accessToken: string;
  presentationId: string;
}

export interface GetPresentationResult {
  presentationId: string;
  title?: string | undefined;
  revisionId?: string | undefined;
  slideCount: number;
}

export async function getPresentation(
  args: GetPresentationArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<GetPresentationResult> {
  const url = `${API_BASE}/${encodeURIComponent(args.presentationId)}`;
  const parsed = await sendJson(presentationSchema, "GET", url, args.accessToken, undefined, retry);

  return {
    presentationId: parsed.presentationId,
    title: parsed.title,
    revisionId: parsed.revisionId,
    slideCount: parsed.slides?.length ?? 0,
  };
}

export interface BatchUpdatePresentationArgs {
  accessToken: string;
  presentationId: string;
  /** Raw Slides `Request` objects. `unknown[]` because the union is huge. */
  requests: unknown[];
}

export interface BatchUpdatePresentationResult {
  replies: unknown[];
}

export async function batchUpdatePresentation(
  args: BatchUpdatePresentationArgs,
): Promise<BatchUpdatePresentationResult> {
  const url = `${API_BASE}/${encodeURIComponent(args.presentationId)}:batchUpdate`;

  const parsed = await sendJson(batchUpdateResponseSchema, "POST", url, args.accessToken, {
    requests: args.requests,
  });

  return { replies: parsed.replies ?? [] };
}

/** The raw reply carries the new objectId. */
export async function addSlide(args: {
  accessToken: string;
  presentationId: string;
  /** Default `BLANK`. */
  layout?: string | undefined;
}): Promise<BatchUpdatePresentationResult> {
  return batchUpdatePresentation({
    accessToken: args.accessToken,
    presentationId: args.presentationId,
    requests: [
      { createSlide: { slideLayoutReference: { predefinedLayout: args.layout ?? "BLANK" } } },
    ],
  });
}

const sendJson = <T>(
  schema: z.ZodType<T>,
  method: "GET" | "POST",
  url: string,
  accessToken: string,
  payload?: unknown,
  retry: RetryPolicy | "none" = "none",
): Promise<T> =>
  googleJson("slides", method, url, accessToken, payload, retry).then((raw) => schema.parse(raw));
