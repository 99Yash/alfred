/**
 * Notion API client (https://developers.notion.com/reference). Thin `fetch`
 * wrapper in the same style as the GitHub PR helper — no SDK. Every call
 * carries the bearer token, the JSON content type, and the pinned
 * `Notion-Version` header Notion requires.
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

async function notionFetch<T>(
  accessToken: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${NOTION_API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[notion] ${res.status} ${init?.method ?? "GET"} ${path} :: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

interface RichText {
  plain_text?: string;
}

/** Best-effort plain-title extraction across page (title property) and database (title array) results. */
function titleOf(result: Record<string, unknown>): string {
  // Database object: `title` is a rich-text array at the top level.
  const topTitle = result.title;
  if (Array.isArray(topTitle)) return joinRichText(topTitle as RichText[]);
  // Page object: find the property whose type is "title".
  const props = result.properties as Record<string, { type?: string; title?: RichText[] }> | undefined;
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
  const page = await notionFetch<Record<string, unknown>>(args.accessToken, `/pages/${args.pageId}`);
  const blocks = await notionFetch<{ results: Array<Record<string, unknown>> }>(
    args.accessToken,
    `/blocks/${args.pageId}/children?page_size=100`,
  );
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
  if (payload?.rich_text && Array.isArray(payload.rich_text)) return joinRichText(payload.rich_text);
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
  const json = await notionFetch<Record<string, unknown>>(args.accessToken, "/pages", {
    method: "POST",
    body: {
      parent: { type: "page_id", page_id: args.parentPageId },
      properties: {
        title: { title: [{ type: "text", text: { content: args.title } }] },
      },
      children: paragraphBlocks(args.content),
    },
  });
  return { id: String(json.id ?? ""), url: typeof json.url === "string" ? json.url : null };
}

export async function notionAppendBlocks(args: {
  accessToken: string;
  blockId: string;
  content: string;
}): Promise<{ appended: number }> {
  const children = paragraphBlocks(args.content);
  await notionFetch(args.accessToken, `/blocks/${args.blockId}/children`, {
    method: "PATCH",
    body: { children },
  });
  return { appended: children.length };
}
