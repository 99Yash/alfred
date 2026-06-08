/**
 * Google Docs tools registered into the boss's tool surface.
 *
 * Read-only tool surface (the grant is now full `documents`, but write
 * tools are separate — ADR-0043): a single `get_document` that flattens a
 * Doc into plain text + a heading outline.
 * Mirrors gmail.ts — resolve the user's active google credential, mint a
 * fresh token, call the thin client.
 */

import { docsGetDocumentInput } from "@alfred/contracts";
import { getDocument, getFreshAccessToken, listCredentials } from "@alfred/integrations/google";
import { liveTool, type RegisteredTool } from "./registry";

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
