/**
 * Google Docs tools registered into the boss's tool surface.
 *
 * Read-only tool surface (the grant is now full `documents`, but write
 * tools are separate — ADR-0043): a single `get_document` that flattens a
 * Doc into plain text + a heading outline.
 * Resolve the user's active Docs-scoped google credential, mint a fresh
 * token, call the thin client — via the shared credential resolver.
 */

import { docsGetDocumentInput, restPassthroughInput } from "@alfred/contracts";
import { DOCS_SCOPE, getDocument, googlePassthroughProfile } from "@alfred/integrations/google";
import { resolveGoogleAccessToken } from "./google-credentials";
import { runRestPassthrough } from "./passthrough";
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
  liveTool({
    integration: "docs",
    action: "request",
    riskTier: "no_risk",
    availability: { passthrough: true },
    description:
      "Issue a raw, READ-ONLY Google Docs REST call for a document's STRUCTURE — the raw body elements, named ranges, styles, inline objects, and headers/footers that the flattened curated read discards. GET '/documents/{documentId}'. To read a document's CONTENT as text, use the curated docs.get_document (or drive.export_file) instead — this raw read is for structure/metadata, and a full document is large, so scope it with a `fields` mask (e.g. 'title,namedRanges,documentStyle') and expect a truncated-and-flagged result if you pull the whole body. Pass `method` (GET or HEAD only — writes are rejected at the boundary), a namespace-relative `path` beginning with '/' (never a full URL and never the '/v1' prefix), and `query` for parameters (fields, suggestionsViewMode). This is a raw, unvalidated read: a 404 may mean your id/path was wrong — NOT that the document is absent. Correct the path once and retry, or state the uncertainty. Never report a raw empty as a confident zero.",
    discovery: {
      aliases: ["docs api", "document structure", "call docs", "docs request"],
      tags: ["docs", "document", "content"],
      entities: ["document", "named range", "style", "inline object"],
      verbs: ["read", "get", "inspect", "query"],
      relatedTools: ["docs.get_document", "drive.export_file"],
    },
    inputSchema: restPassthroughInput,
    execute: async (input, ctx) => {
      const token = await accessTokenFor(ctx.userId);
      return runRestPassthrough("docs", googlePassthroughProfile("docs", token), input);
    },
  }),
];
