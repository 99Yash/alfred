import { z } from "zod";

/**
 * Thin Google Slides v1 REST client. Same shape as `gmail.ts` /
 * `calendar.ts` — direct JSON calls, no `googleapis` dependency.
 *
 * Surface covers create + edit: make a presentation, fetch it, and an
 * escape-hatch `batchUpdate`. Almost every Slides mutation (add a slide,
 * insert text, create shapes/images) goes through `batchUpdate` with the
 * request objects from https://developers.google.com/slides/api/reference/rest,
 * so the generic call plus an `addSlide` convenience cover the common cases.
 *
 * Callers pass an already-fresh access token — get it from
 * `getFreshAccessToken(credentialId)` first. Requires the `presentations`
 * scope (see `SLIDES_SCOPE` in oauth.ts).
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
  /** Slide page objects — left loose; callers that need deep structure parse further. */
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
  title?: string;
}

/** Create a new presentation (lands in the user's Drive root). */
export async function createPresentation(
  args: CreatePresentationArgs,
): Promise<CreatePresentationResult> {
  const json = await sendJson("POST", API_BASE, args.accessToken, { title: args.title });
  const parsed = createPresentationResponseSchema.parse(json);
  return { presentationId: parsed.presentationId, title: parsed.title };
}

export interface GetPresentationArgs {
  accessToken: string;
  presentationId: string;
}

export interface GetPresentationResult {
  presentationId: string;
  title?: string;
  revisionId?: string;
  slideCount: number;
}

/** Fetch a presentation's metadata + slide count. */
export async function getPresentation(args: GetPresentationArgs): Promise<GetPresentationResult> {
  const url = `${API_BASE}/${encodeURIComponent(args.presentationId)}`;
  const json = await sendJson("GET", url, args.accessToken);
  const parsed = presentationSchema.parse(json);
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
  /**
   * Raw Slides API `Request` objects (createSlide, insertText, createShape, …).
   * Typed as `unknown[]` deliberately — the request union is huge and callers
   * pass shapes straight from Google's reference.
   */
  requests: unknown[];
}

export interface BatchUpdatePresentationResult {
  replies: unknown[];
}

/** Escape hatch for edits: add slides, insert text, create shapes/images, etc. */
export async function batchUpdatePresentation(
  args: BatchUpdatePresentationArgs,
): Promise<BatchUpdatePresentationResult> {
  const url = `${API_BASE}/${encodeURIComponent(args.presentationId)}:batchUpdate`;
  const json = await sendJson("POST", url, args.accessToken, { requests: args.requests });
  const parsed = batchUpdateResponseSchema.parse(json);
  return { replies: parsed.replies ?? [] };
}

/** Convenience: append a blank slide. Returns the raw reply (carries the new objectId). */
export async function addSlide(args: {
  accessToken: string;
  presentationId: string;
  /** Predefined layout, e.g. `BLANK`, `TITLE_AND_BODY`. Defaults to BLANK. */
  layout?: string;
}): Promise<BatchUpdatePresentationResult> {
  return batchUpdatePresentation({
    accessToken: args.accessToken,
    presentationId: args.presentationId,
    requests: [
      { createSlide: { slideLayoutReference: { predefinedLayout: args.layout ?? "BLANK" } } },
    ],
  });
}

const SLIDES_FETCH_TIMEOUT_MS = 30_000;

async function sendJson(
  method: "GET" | "POST",
  url: string,
  accessToken: string,
  payload?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(SLIDES_FETCH_TIMEOUT_MS),
  };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(payload ?? {});
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[slides] ${method} ${res.status} ${url} :: ${body.slice(0, 500)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}
