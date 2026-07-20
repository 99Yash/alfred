/**
 * Google Slides tools registered into the boss's tool surface.
 *
 * `slides.get_presentation` is a read path; create/add_slide/batch_update
 * mutate the user's Drive and register at a write-grade risk tier. The
 * dispatcher's gate is `user_action_policies`, not the tier (per the
 * registry note / ADR-0034).
 *
 * Almost every Slides mutation flows through `batch_update` with the raw
 * request objects from Google's reference; `add_slide` is the one
 * convenience wrapper, mirroring the client surface.
 */

import {
  restPassthroughInput,
  slidesAddSlideInput,
  slidesBatchUpdateInput,
  slidesCreateInput,
  slidesGetInput,
} from "@alfred/contracts";
import {
  addSlide,
  batchUpdatePresentation,
  createPresentation,
  getPresentation,
  googlePassthroughProfile,
  SLIDES_SCOPE,
} from "@alfred/integrations/google";
import { resolveGoogleAccessToken } from "./google-credentials";
import { runRestPassthrough } from "./passthrough";
import { liveTool, type RegisteredTool } from "./registry";

/** Resolve an access token for a Slides call — requires the `presentations` scope. */
function accessTokenFor(userId: string): Promise<string> {
  return resolveGoogleAccessToken(userId, {
    scopes: [SLIDES_SCOPE],
    noConnection: "google_connection_required",
    noScope: "slides_scope_required",
  });
}

export const slidesTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "slides",
    action: "create_presentation",
    riskTier: "medium",
    description: "Create a new Google Slides presentation in the user's Drive.",
    inputSchema: slidesCreateInput,
    execute: async (input, ctx) => {
      const accessToken = await accessTokenFor(ctx.userId);
      return createPresentation({ accessToken, title: input.title });
    },
  }),
  liveTool({
    integration: "slides",
    action: "get_presentation",
    riskTier: "no_risk",
    description: "Fetch a presentation's title, revision, and slide count.",
    inputSchema: slidesGetInput,
    execute: async (input, ctx) => {
      const accessToken = await accessTokenFor(ctx.userId);
      return getPresentation({ accessToken, presentationId: input.presentationId });
    },
  }),
  liveTool({
    integration: "slides",
    action: "batch_update",
    riskTier: "medium",
    description:
      "Edit a presentation (add slides, insert text, create shapes/images, …) via raw Slides API request objects.",
    inputSchema: slidesBatchUpdateInput,
    execute: async (input, ctx) => {
      const accessToken = await accessTokenFor(ctx.userId);
      return batchUpdatePresentation({
        accessToken,
        presentationId: input.presentationId,
        requests: input.requests,
      });
    },
  }),
  liveTool({
    integration: "slides",
    action: "add_slide",
    riskTier: "medium",
    description: "Append a blank slide (optionally with a predefined layout) to a presentation.",
    inputSchema: slidesAddSlideInput,
    execute: async (input, ctx) => {
      const accessToken = await accessTokenFor(ctx.userId);
      return addSlide({
        accessToken,
        presentationId: input.presentationId,
        layout: input.layout,
      });
    },
  }),
  liveTool({
    integration: "slides",
    action: "request",
    riskTier: "no_risk",
    availability: { passthrough: true },
    description:
      "Issue a raw, READ-ONLY Google Slides REST call for a presentation's STRUCTURE — its slides, layouts, masters, and the page elements (shapes, text, images) on a single page. GET '/presentations/{presentationId}' returns the whole deck (scope it with a `fields` mask like 'slides.objectId,title'; the full deck is large and will be truncated-and-flagged), or read one page with GET '/presentations/{presentationId}/pages/{pageObjectId}'. Prefer the targeted per-page read over dumping the whole presentation. The curated slides.get_presentation returns the title/revision/slide count for a quick summary. Pass `method` (GET or HEAD only — writes are rejected at the boundary), a namespace-relative `path` beginning with '/' (never a full URL and never the '/v1' prefix), and `query` for parameters (fields). This is a raw, unvalidated read: a 404 may mean your id/path was wrong — NOT that the thing is absent. Correct the path once and retry, or state the uncertainty. Never report a raw empty as a confident zero.",
    discovery: {
      aliases: ["slides api", "presentation structure", "call slides", "slides request"],
      tags: ["slides", "presentation", "deck"],
      entities: ["presentation", "slide", "page", "shape", "layout"],
      verbs: ["read", "get", "inspect", "query"],
      relatedTools: ["slides.get_presentation"],
    },
    inputSchema: restPassthroughInput,
    execute: async (input, ctx) => {
      const token = await accessTokenFor(ctx.userId);
      return runRestPassthrough("slides", googlePassthroughProfile("slides", token), input);
    },
  }),
];
