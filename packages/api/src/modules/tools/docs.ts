/**
 * Google Docs tools registered into the boss's tool surface.
 *
 * Read-only at the current grant (`documents.readonly`): a single
 * `get_document` that flattens a Doc into plain text + a heading outline.
 * Mirrors gmail.ts — resolve the user's active google credential, mint a
 * fresh token, call the thin client.
 */

import { getDocument, getFreshAccessToken, listCredentials } from "@alfred/integrations/google";
import { z } from "zod";
import { liveTool, type RegisteredTool } from "./registry";

const docsGetDocumentInput = z
  .object({
    documentId: z.string().min(1).max(200).describe("The Google Doc's document id."),
  })
  .strict();

async function accessTokenFor(userId: string): Promise<string> {
  const creds = await listCredentials(userId, "google");
  const active = creds.find((c) => c.status === "active");
  if (!active) {
    throw new Error(
      `[docs.tools] user ${userId} has no active google credential — reconnect in settings`,
    );
  }
  return getFreshAccessToken(active.id);
}

export const docsTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "docs",
    action: "get_document",
    riskTier: "low",
    description:
      "Read a Google Doc's full text and heading outline. Provide the document id (from a Drive search or a Docs URL).",
    inputSchema: docsGetDocumentInput,
    execute: async (input, ctx) => {
      const accessToken = await accessTokenFor(ctx.userId);
      return getDocument({ accessToken, documentId: input.documentId });
    },
  }),
];
