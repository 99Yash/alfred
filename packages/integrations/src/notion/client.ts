/**
 * Notion API client (https://developers.notion.com/reference). Thin `fetch`
 * wrapper in the same style as the GitHub PR helper — no SDK. Every call
 * carries the bearer token, the JSON content type, and the pinned
 * `Notion-Version` header Notion requires.
 */

import { z } from "zod";

import type { ProviderBindOptions } from "../shared/provider";
import { authedJson } from "../shared/authed-json";
import { getActiveBearerCredential } from "../shared/credentials";
import { restPassthroughCapability, type RestPassthroughProfile } from "../shared/rest-passthrough";
import type { RetryPolicy } from "../shared/retry";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/**
 * Transport profile for the general read-only passthrough tier (ADR-0074): the
 * pinned Notion REST authority, bearer auth, and the mandatory `Notion-Version`
 * header. The transport adds `Content-Type` only when a read-via-POST body is
 * sent, so it is deliberately absent here.
 */
function notionPassthroughProfile(token: string): RestPassthroughProfile {
  return {
    baseUrl: NOTION_API,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      Accept: "application/json",
    },
  };
}

/**
 * A single authenticated Notion call. Returns the parsed JSON body as `unknown`;
 * each caller validates it with a `zod` schema (no `as T` on `response.json()`).
 *
 * Uses `bodyPolicy: "omit"`: Notion's error bodies can echo request fragments
 * and these errors propagate into the tool dispatcher / telemetry, so the body
 * is logged server-side (in {@link authedJson}) but never rides the thrown error.
 */
async function notionFetch(
  accessToken: string,
  path: string,
  init?: { method?: string; body?: unknown },
  retry: RetryPolicy | "none" = "none",
  idempotent?: true,
): Promise<unknown> {
  return authedJson(
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Notion-Version": NOTION_VERSION,
        Accept: "application/json",
      },
    },
    { url: `${NOTION_API}${path}`, method: init?.method, body: init?.body },
    { provider: "notion", bodyPolicy: "omit", retry, ...(idempotent ? { idempotent } : {}) },
  );
}

/** A Notion object (page/database/block) — arbitrary keys, extracted defensively. */
const notionObjectSchema = z.record(z.string(), z.unknown());
/** A `search`/`children` list response: a `results` array of Notion objects. */
const notionListSchema = z.object({
  results: z.array(notionObjectSchema),
  has_more: z.boolean().optional(),
});

/** Notion rejects a single request with more than 100 child blocks. */
const NOTION_MAX_CHILDREN_PER_REQUEST = 100;

interface RichText {
  plain_text?: string | undefined;
}

/** Best-effort plain-title extraction across page (title property) and database (title array) results. */
function titleOf(result: Record<string, unknown>): string {
  // Database object: `title` is a rich-text array at the top level.
  const topTitle = result.title;
  if (Array.isArray(topTitle)) return joinRichText(topTitle as RichText[]);
  // Page object: find the property whose type is "title".
  const props = result.properties as
    | Record<string, { type?: string; title?: RichText[] }>
    | undefined;
  if (props) {
    for (const value of Object.values(props)) {
      if (value?.type === "title" && Array.isArray(value.title)) return joinRichText(value.title);
    }
  }
  return "";
}

function joinRichText(parts: RichText[]): string {
  return parts
    .map((p) => p.plain_text ?? "")
    .join("")
    .trim();
}

export interface NotionSearchHit {
  id: string;
  object: string;
  title: string;
  url: string | null;
  lastEditedTime: string | null;
}

export interface NotionSearchResult {
  hits: NotionSearchHit[];
  hasMore: boolean;
}

async function notionSearch(
  accessToken: string,
  args: {
    query?: string | undefined;
    filter: "page" | "database" | "all";
    pageSize: number;
  },
  retry: RetryPolicy | "none",
): Promise<NotionSearchResult> {
  const body: Record<string, unknown> = { page_size: args.pageSize };
  if (args.query) body.query = args.query;
  if (args.filter !== "all") body.filter = { value: args.filter, property: "object" };
  const json = notionListSchema.parse(
    await notionFetch(accessToken, "/search", { method: "POST", body }, retry, true),
  );
  return {
    hits: json.results.map((r) => ({
      id: String(r.id ?? ""),
      object: String(r.object ?? ""),
      title: titleOf(r),
      url: typeof r.url === "string" ? r.url : null,
      lastEditedTime: typeof r.last_edited_time === "string" ? r.last_edited_time : null,
    })),
    hasMore: Boolean(json.has_more),
  };
}

export interface NotionPage {
  id: string;
  title: string;
  url: string | null;
  lastEditedTime: string | null;
  /** Flattened plain-text of the page's top-level blocks (first 100). */
  text: string;
}

/** Pull a page's metadata plus a plain-text rendering of its top-level blocks. */
async function notionGetPage(
  accessToken: string,
  args: { pageId: string },
  retry: RetryPolicy | "none",
): Promise<NotionPage> {
  // The two reads are independent — fetch them concurrently (~half the latency).
  const id = encodeURIComponent(args.pageId);
  const [pageRaw, blocksRaw] = await Promise.all([
    notionFetch(accessToken, `/pages/${id}`, undefined, retry),
    notionFetch(accessToken, `/blocks/${id}/children?page_size=100`, undefined, retry),
  ]);
  const page = notionObjectSchema.parse(pageRaw);
  const blocks = notionListSchema.parse(blocksRaw);
  return {
    id: String(page.id ?? args.pageId),
    title: titleOf(page),
    url: typeof page.url === "string" ? page.url : null,
    lastEditedTime: typeof page.last_edited_time === "string" ? page.last_edited_time : null,
    text: blocks.results.map(blockToText).filter(Boolean).join("\n"),
  };
}

/** Render the common text-bearing block types to plain text; ignore the rest. */
function blockToText(block: Record<string, unknown>): string {
  const type = typeof block.type === "string" ? block.type : "";
  const payload = block[type] as { rich_text?: RichText[] } | undefined;
  if (payload?.rich_text && Array.isArray(payload.rich_text))
    return joinRichText(payload.rich_text);
  return "";
}

/** Turn newline-separated text into Notion paragraph blocks. */
function paragraphBlocks(content: string | undefined): Array<Record<string, unknown>> {
  if (!content) return [];
  return content.split("\n").map((line) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: line ? [{ type: "text", text: { content: line } }] : [] },
  }));
}

/** PATCH children onto a block in ≤100-block batches (Notion's per-request cap). */
async function appendChildrenInBatches(
  accessToken: string,
  blockId: string,
  children: Array<Record<string, unknown>>,
): Promise<void> {
  const id = encodeURIComponent(blockId);
  for (let i = 0; i < children.length; i += NOTION_MAX_CHILDREN_PER_REQUEST) {
    await notionFetch(accessToken, `/blocks/${id}/children`, {
      method: "PATCH",
      body: { children: children.slice(i, i + NOTION_MAX_CHILDREN_PER_REQUEST) },
    });
  }
}

export interface NotionCreatedPage {
  id: string;
  url: string | null;
}

async function notionCreatePage(
  accessToken: string,
  args: {
    parentPageId: string;
    title: string;
    content?: string | undefined;
  },
): Promise<NotionCreatedPage> {
  // Notion caps a single request at 100 child blocks: create the page with the
  // first batch inline, then PATCH the remainder in further ≤100 batches.
  const children = paragraphBlocks(args.content);
  const json = notionObjectSchema.parse(
    await notionFetch(accessToken, "/pages", {
      method: "POST",
      body: {
        parent: { type: "page_id", page_id: args.parentPageId },
        properties: {
          title: { title: [{ type: "text", text: { content: args.title } }] },
        },
        children: children.slice(0, NOTION_MAX_CHILDREN_PER_REQUEST),
      },
    }),
  );
  const pageId = String(json.id ?? "");
  if (pageId && children.length > NOTION_MAX_CHILDREN_PER_REQUEST) {
    await appendChildrenInBatches(
      accessToken,
      pageId,
      children.slice(NOTION_MAX_CHILDREN_PER_REQUEST),
    );
  }
  return { id: pageId, url: typeof json.url === "string" ? json.url : null };
}

async function notionAppendBlocks(
  accessToken: string,
  args: { blockId: string; content: string },
): Promise<{ appended: number }> {
  const children = paragraphBlocks(args.content);
  await appendChildrenInBatches(accessToken, args.blockId, children);
  return { appended: children.length };
}

export interface NotionTokenResolver {
  (): Promise<string>;
}

/** Configured Notion client over a fresh-token resolver. */
export function createNotionClient(
  resolveToken: NotionTokenResolver,
  retry: RetryPolicy | "none" = "none",
) {
  const passthrough = restPassthroughCapability({
    slug: "notion",
    retry,
    resolveProfile: async () => notionPassthroughProfile(await resolveToken()),
  });
  return {
    async search(args: Parameters<typeof notionSearch>[1]) {
      return notionSearch(await resolveToken(), args, retry);
    },
    async getPage(args: Parameters<typeof notionGetPage>[1]) {
      return notionGetPage(await resolveToken(), args, retry);
    },
    async createPage(args: Parameters<typeof notionCreatePage>[1]) {
      return notionCreatePage(await resolveToken(), args);
    },
    async appendBlocks(args: Parameters<typeof notionAppendBlocks>[1]) {
      return notionAppendBlocks(await resolveToken(), args);
    },
    passthrough,
  };
}

/**
 * The user-bound Notion door. The bearer credential is resolved per method so a
 * rotated token is used immediately and never leaves the integrations package.
 */
export function notionClientForUser(options: ProviderBindOptions) {
  return createNotionClient(
    async () => (await getActiveBearerCredential(options.userId, "notion")).accessToken,
    options.retry,
  );
}

export type NotionClient = ReturnType<typeof notionClientForUser>;
