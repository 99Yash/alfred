/** Notion API client (https://developers.notion.com/reference), no SDK. */

import { z } from "zod";

import type { ProviderBindOptions } from "../shared/provider";
import { authedJson } from "../shared/authed-json";
import { getActiveBearerCredential } from "../shared/credentials";
import { restPassthroughCapability, type RestPassthroughProfile } from "../shared/rest-passthrough";
import type { RetryPolicy } from "../shared/retry";

const NOTION_API = "https://api.notion.com/v1";

const NOTION_VERSION = "2022-06-28";

/** Read-only passthrough profile (ADR-0074). Notion requires `Notion-Version`. */
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
 * `bodyPolicy: "omit"`: Notion error bodies can echo request fragments, so the body
 * is logged but never rides the thrown error.
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

const richTextSchema = z.object({ plain_text: z.string().catch("").optional() });

type RichText = z.infer<typeof richTextSchema>;

const notionTitleFieldsSchema = z.object({
  // Database title. A malformed one becomes empty instead of failing the search.
  title: z.array(richTextSchema).catch([]).optional(),
  // Parse only the title property, so another malformed property cannot hide the page.
  properties: z.record(z.string(), z.unknown()).optional(),
});

type NotionTitleFields = z.infer<typeof notionTitleFieldsSchema>;

const notionTitlePropertySchema = z.object({
  type: z.string(),
  title: z.array(richTextSchema).catch([]).optional(),
});

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

const notionPageSchema = notionTitleFieldsSchema.extend({
  id: z.string(),
  url: z.string().nullable().optional(),
  last_edited_time: z.string().nullable().optional(),
});

const notionCreatedPageSchema = z.object({
  id: z.string(),
  url: z.string().nullable().optional(),
});

const notionBlockSchema = z.object({ type: z.string() }).catchall(z.unknown());

type NotionBlock = z.infer<typeof notionBlockSchema>;

const notionBlockChildrenResponseSchema = z.object({
  results: z.array(notionBlockSchema),
  has_more: z.boolean().optional(),
});

/** The payload under a block's type key (paragraph, heading, list item). */
const textPayloadSchema = z.object({ rich_text: z.array(richTextSchema).optional() });

function paragraphBlock(content: string) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: content ? [{ type: "text", text: { content } }] : [] },
  } as const;
}

type ParagraphBlock = ReturnType<typeof paragraphBlock>;

/** Notion rejects more than 100 child blocks per request. */
const NOTION_MAX_CHILDREN_PER_REQUEST = 100;

function titleOf(result: NotionTitleFields): string {
  // A database has a top-level `title`.
  if (result.title !== undefined) return joinRichText(result.title);
  // A page has a property of type "title".
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
  /** Plain text of the first 100 top-level blocks. */
  text: string;
}

async function notionGetPage(
  accessToken: string,
  args: { pageId: string },
  retry: RetryPolicy | "none",
): Promise<NotionPage> {
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

function blockToText(block: NotionBlock): string {
  const payload = textPayloadSchema.safeParse(block[block.type]);

  return payload.success ? joinRichText(payload.data.rich_text ?? []) : "";
}

function paragraphBlocks(content: string | undefined): ParagraphBlock[] {
  if (!content) return [];

  return content.split("\n").map(paragraphBlock);
}

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
  // Create with the first 100 blocks, then PATCH the rest in batches of 100.
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

/** Resolves the token per method, so a rotated token applies at once. */
export function notionClientForUser(options: ProviderBindOptions) {
  return createNotionClient(
    async () =>
      (await getActiveBearerCredential(options.userId, "notion", options.accountRef)).accessToken,
    options.retry,
  );
}

export type NotionClient = ReturnType<typeof notionClientForUser>;
