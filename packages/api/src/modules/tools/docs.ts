/**
 * Google Docs tools registered into the boss's tool surface.
 *
 * Read-only tool surface (the grant is now full `documents`, but write
 * tools are separate — ADR-0043): a single `get_document` that flattens a
 * Doc into plain text + a heading outline.
 * Resolve the user's active Docs-scoped google credential, mint a fresh
 * token, call the thin client — via the shared credential resolver.
 */

import { docsGetDocumentInput } from "@alfred/contracts";
import { DOCS_SCOPE, getDocument } from "@alfred/integrations/google";
import { resolveGoogleAccessToken } from "./google-credentials";
import { liveTool, type RegisteredTool } from "./registry";

/** Resolve an access token for a Docs call — requires the `documents` scope. */
function accessTokenFor(userId: string): Promise<string> {
  return resolveGoogleAccessToken(userId, {
    scopes: [DOCS_SCOPE],
    noConnection: "google_connection_required",
    noScope: "docs_scope_required",
  });
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
