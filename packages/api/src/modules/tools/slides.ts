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
  slidesAddSlideInput,
  slidesBatchUpdateInput,
  slidesCreateInput,
  slidesGetInput,
} from "@alfred/contracts";
import {
  addSlide,
  batchUpdatePresentation,
  createPresentation,
  getFreshAccessToken,
  getPresentation,
  listCredentials,
} from "@alfred/integrations/google";
import { liveTool, type RegisteredTool } from "./registry";

async function pickGoogleCredentialId(userId: string): Promise<string> {
  const creds = await listCredentials(userId, "google");
  const active = creds.find((c) => c.status === "active");
  if (!active) {
    throw new Error(
      `[slides.tools] user ${userId} has no active google credential — reconnect in settings`,
    );
  }
  return active.id;
}

async function accessTokenFor(userId: string): Promise<string> {
  return getFreshAccessToken(await pickGoogleCredentialId(userId));
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
];
