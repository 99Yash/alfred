/**
 * Notion tools registered into the boss's tool surface (read + write).
 *
 * Reads (search, get_page) are no-risk; writes (create_page, append_blocks)
 * are gated by `user_action_policies` like every other mutation — the tier
 * here is only a UX hint. All four resolve the user's active Notion bearer
 * credential via the shared bearer-credential layer.
 */

import {
  notionAppendBlocksInput,
  notionCreatePageInput,
  notionGetPageInput,
  notionSearchInput,
  restPassthroughInput,
} from "@alfred/contracts";
import {
  notionAppendBlocks,
  notionCreatePage,
  notionGetPage,
  notionPassthroughProfile,
  notionSearch,
} from "@alfred/integrations/notion";
import { getActiveBearerCredential } from "@alfred/integrations/shared";
import { runRestPassthrough } from "./passthrough";
import { liveTool, type RegisteredTool } from "./registry";

async function tokenFor(userId: string): Promise<string> {
  const { accessToken } = await getActiveBearerCredential(userId, "notion");
  return accessToken;
}

export const notionTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "notion",
    action: "search",
    riskTier: "no_risk",
    description:
      "Search the connected Notion workspace for pages and databases the integration can see. Returns id, title, url, and last-edited time. Use filter to restrict to pages or databases.",
    inputSchema: notionSearchInput,
    execute: async (input, ctx) => {
      const accessToken = await tokenFor(ctx.userId);
      return notionSearch({
        accessToken,
        query: input.query,
        filter: input.filter,
        pageSize: input.pageSize,
      });
    },
  }),
  liveTool({
    integration: "notion",
    action: "get_page",
    riskTier: "no_risk",
    description:
      "Read a Notion page: its title, url, and a plain-text rendering of its top-level blocks. Pass the page id from a search result.",
    inputSchema: notionGetPageInput,
    execute: async (input, ctx) => {
      const accessToken = await tokenFor(ctx.userId);
      return notionGetPage({ accessToken, pageId: input.pageId });
    },
  }),
  liveTool({
    integration: "notion",
    action: "create_page",
    riskTier: "medium",
    description:
      "Create a new Notion page nested under an existing parent page (the integration must be shared with the parent). Optional content becomes paragraph blocks, one per line.",
    inputSchema: notionCreatePageInput,
    execute: async (input, ctx) => {
      const accessToken = await tokenFor(ctx.userId);
      return notionCreatePage({
        accessToken,
        parentPageId: input.parentPageId,
        title: input.title,
        content: input.content,
      });
    },
  }),
  liveTool({
    integration: "notion",
    action: "append_blocks",
    riskTier: "medium",
    description: "Append paragraph blocks (one per line) to an existing Notion page or block.",
    inputSchema: notionAppendBlocksInput,
    execute: async (input, ctx) => {
      const accessToken = await tokenFor(ctx.userId);
      return notionAppendBlocks({ accessToken, blockId: input.blockId, content: input.content });
    },
  }),
  liveTool({
    integration: "notion",
    action: "request",
    riskTier: "no_risk",
    availability: { passthrough: true },
    description:
      "Issue a raw, READ-ONLY Notion API call for STRUCTURE and metadata the curated notion tools don't cover — a database's properties/schema (GET '/databases/{id}'), a block's children (GET '/blocks/{id}/children'), page metadata (GET '/pages/{id}'), or the two read-via-POST endpoints: full-text search (POST '/search') and database query (POST '/databases/{id}/query', where a JSON `body` carries the filter/sort). GET/HEAD and those two POST paths are the only reads permitted; every other write is rejected at the boundary. This is for structure/metadata — to read a page's CONTENT as text, use the curated notion.get_page instead. This is a raw, unvalidated read: a 404 or empty result may mean your id/path was wrong — NOT that the thing is absent. Correct the path once and retry, or state the uncertainty. Never report a raw empty as a confident zero.",
    discovery: {
      aliases: ["notion api", "notion request", "call notion", "notion database schema"],
      tags: ["notion", "docs", "knowledge"],
      entities: ["database", "page", "block", "property", "schema"],
      verbs: ["read", "inspect", "query", "search", "get"],
      relatedTools: ["notion.search", "notion.get_page"],
    },
    inputSchema: restPassthroughInput,
    execute: async (input, ctx) => {
      const accessToken = await tokenFor(ctx.userId);
      return runRestPassthrough("notion", notionPassthroughProfile(accessToken), input);
    },
  }),
];
