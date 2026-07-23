/**
 * Notion API client (https://developers.notion.com/reference). Thin `fetch`
 * wrapper in the same style as the GitHub PR helper — no SDK. Every call
 * carries the bearer token, the JSON content type, and the pinned
 * `Notion-Version` header Notion requires.
 */

import { HttpError, summarizeBody } from "@alfred/contracts";
import { authedFetch } from "../shared/authed-fetch";
import type { RestPassthroughProfile } from "../shared/rest-passthrough";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/**
 * Transport profile for the general read-only passthrough tier (ADR-0074): the
 * pinned Notion REST authority, bearer auth, and the mandatory `Notion-Version`
 * header. The transport adds `Content-Type` only when a read-via-POST body is
 * sent, so it is deliberately absent here.
 */
export function notionPassthroughProfile(token: string): RestPassthroughProfile {
  return {
    baseUrl: NOTION_API,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      Accept: "application/json",
    },
  };
}

async function notionFetch<T>(
  accessToken: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await authedFetch(
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Notion-Version": NOTION_VERSION,
        Accept: "application/json",
      },
    },
    { url: `${NOTION_API}${path}`, method: init?.method, body: init?.body },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Keep the (redacted, bounded) upstream body for server logs, but don't
    // splice it into the thrown message: these errors propagate to the tool
    // dispatcher and on into logs/telemetry, and Notion's body can echo request
    // fragments. The structured HttpError still carries the status so callers
    // can branch without parsing the message.
    console.error(
      `[notion] ${res.status} ${init?.method ?? "GET"} ${path} :: ${summarizeBody(text)}`,
    );
    throw new HttpError({
      provider: "notion",
      status: res.status,
      url: `${NOTION_API}${path}`,
      method: init?.method ?? "GET",
      body: "",
    });
  }
  return (await res.json()) as T;
}

/** Notion rejects a single request with more than 100 child blocks. */
const NOTION_MAX_CHILDREN_PER_REQUEST = 100;

interface RichText {
  plain_text?: string;
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

export async function notionSearch(args: {
  accessToken: string;
  query?: string;
  filter: "page" | "database" | "all";
  pageSize: number;
}): Promise<NotionSearchResult> {
  const body: Record<string, unknown> = { page_size: args.pageSize };
  if (args.query) body.query = args.query;
  if (args.filter !== "all") body.filter = { value: args.filter, property: "object" };
  const json = await notionFetch<{
    results: Array<Record<string, unknown>>;
    has_more: boolean;
  }>(args.accessToken, "/search", { method: "POST", body });
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
export async function notionGetPage(args: {
  accessToken: string;
  pageId: string;
}): Promise<NotionPage> {
  // The two reads are independent — fetch them concurrently (~half the latency).
  const id = encodeURIComponent(args.pageId);
  const [page, blocks] = await Promise.all([
    notionFetch<Record<string, unknown>>(args.accessToken, `/pages/${id}`),
    notionFetch<{ results: Array<Record<string, unknown>> }>(
      args.accessToken,
      `/blocks/${id}/children?page_size=100`,
    ),
  ]);
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

export async function notionCreatePage(args: {
  accessToken: string;
  parentPageId: string;
  title: string;
  content?: string;
}): Promise<NotionCreatedPage> {
  // Notion caps a single request at 100 child blocks: create the page with the
  // first batch inline, then PATCH the remainder in further ≤100 batches.
  const children = paragraphBlocks(args.content);
  const json = await notionFetch<Record<string, unknown>>(args.accessToken, "/pages", {
    method: "POST",
    body: {
      parent: { type: "page_id", page_id: args.parentPageId },
      properties: {
        title: { title: [{ type: "text", text: { content: args.title } }] },
      },
      children: children.slice(0, NOTION_MAX_CHILDREN_PER_REQUEST),
    },
  });
  const pageId = String(json.id ?? "");
  if (pageId && children.length > NOTION_MAX_CHILDREN_PER_REQUEST) {
    await appendChildrenInBatches(
      args.accessToken,
      pageId,
      children.slice(NOTION_MAX_CHILDREN_PER_REQUEST),
    );
  }
  return { id: pageId, url: typeof json.url === "string" ? json.url : null };
}

export async function notionAppendBlocks(args: {
  accessToken: string;
  blockId: string;
  content: string;
}): Promise<{ appended: number }> {
  const children = paragraphBlocks(args.content);
  await appendChildrenInBatches(args.accessToken, args.blockId, children);
  return { appended: children.length };
}
