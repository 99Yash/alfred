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

/** A Notion rich-text span. */
const richTextSchema = z.object({ plain_text: z.string().catch("").optional() });
type RichText = z.infer<typeof richTextSchema>;

/** The title fields shared by page and database search projections. */
const notionTitleFieldsSchema = z.object({
  // Databases carry a top-level title. A malformed title is non-essential and
  // degrades to empty instead of failing the complete search response.
  title: z.array(richTextSchema).catch([]).optional(),
  // Page property names are user-defined. Parse only the property selected by
  // its `type`, so one unrelated malformed property cannot hide the page.
  properties: z.record(z.string(), z.unknown()).optional(),
});
type NotionTitleFields = z.infer<typeof notionTitleFieldsSchema>;

const notionTitlePropertySchema = z.object({
  type: z.string(),
  title: z.array(richTextSchema).catch([]).optional(),
});

/** One page or database result from `/search`. */
const notionSearchObjectSchema = notionTitleFieldsSchema.extend({
  id: z.string(),
  object: z.string(),
  url: z.string().nullable().optional(),
  last_edited_time: z.string().nullable().optional(),
});

const notionSearchResponseSchema = z.object({
  results: z.array(notionSearchObjectSchema),
  has_more: z.boolean().optional(),
});

/** One page response from `GET /pages/:id`. */
const notionPageSchema = notionTitleFieldsSchema.extend({
  id: z.string(),
  url: z.string().nullable().optional(),
  last_edited_time: z.string().nullable().optional(),
});

/** The minimal response from `POST /pages`. */
const notionCreatedPageSchema = z.object({
  id: z.string(),
  url: z.string().nullable().optional(),
});

/** A block keeps its dynamic type payload; search/page projections do not. */
const notionBlockSchema = z.object({ type: z.string() }).catchall(z.unknown());
type NotionBlock = z.infer<typeof notionBlockSchema>;

const notionBlockChildrenResponseSchema = z.object({
  results: z.array(notionBlockSchema),
  has_more: z.boolean().optional(),
});

/** The text-bearing payload under a block's type key (paragraph, heading, list item, ...). */
const textPayloadSchema = z.object({ rich_text: z.array(richTextSchema).optional() });

function paragraphBlock(content: string) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: content ? [{ type: "text", text: { content } }] : [] },
  } as const;
}
type ParagraphBlock = ReturnType<typeof paragraphBlock>;

/** Notion rejects a single request with more than 100 child blocks. */
const NOTION_MAX_CHILDREN_PER_REQUEST = 100;

/** Best-effort plain-title extraction across page (title property) and database (title array) results. */
function titleOf(result: NotionTitleFields): string {
  // Database object: `title` is a rich-text array at the top level.
  if (result.title !== undefined) return joinRichText(result.title);
  // Page object: find the property whose type is "title".
  const props = result.properties;
  if (props) {
    for (const value of Object.values(props)) {
      const parsed = notionTitlePropertySchema.safeParse(value);
      if (parsed.success && parsed.data.type === "title") {
        return joinRichText(parsed.data.title ?? []);
      }
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
  const body = {
    page_size: args.pageSize,
    ...(args.query ? { query: args.query } : {}),
    ...(args.filter !== "all" ? { filter: { value: args.filter, property: "object" } } : {}),
  };
  const json = notionSearchResponseSchema.parse(
    await notionFetch(accessToken, "/search", { method: "POST", body }, retry, true),
  );
  return {
    hits: json.results.map((r) => ({
      id: r.id,
      object: r.object,
      title: titleOf(r),
      url: r.url ?? null,
      lastEditedTime: r.last_edited_time ?? null,
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
  const page = notionPageSchema.parse(pageRaw);
  const blocks = notionBlockChildrenResponseSchema.parse(blocksRaw);
  return {
    id: page.id,
    title: titleOf(page),
    url: page.url ?? null,
    lastEditedTime: page.last_edited_time ?? null,
    text: blocks.results.map(blockToText).filter(Boolean).join("\n"),
  };
}

/** Render the common text-bearing block types to plain text; ignore the rest. */
function blockToText(block: NotionBlock): string {
  const payload = textPayloadSchema.safeParse(block[block.type]);
  return payload.success ? joinRichText(payload.data.rich_text ?? []) : "";
}

/** Turn newline-separated text into Notion paragraph blocks. */
function paragraphBlocks(content: string | undefined): ParagraphBlock[] {
  if (!content) return [];
  return content.split("\n").map(paragraphBlock);
}

/** PATCH children onto a block in ≤100-block batches (Notion's per-request cap). */
async function appendChildrenInBatches(
  accessToken: string,
  blockId: string,
  children: ParagraphBlock[],
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
  const json = notionCreatedPageSchema.parse(
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
  const pageId = json.id;
  if (pageId && children.length > NOTION_MAX_CHILDREN_PER_REQUEST) {
    await appendChildrenInBatches(
      accessToken,
      pageId,
      children.slice(NOTION_MAX_CHILDREN_PER_REQUEST),
    );
  }
  return { id: pageId, url: json.url ?? null };
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
    async () =>
      (await getActiveBearerCredential(options.userId, "notion", options.accountRef)).accessToken,
    options.retry,
  );
}

export type NotionClient = ReturnType<typeof notionClientForUser>;
