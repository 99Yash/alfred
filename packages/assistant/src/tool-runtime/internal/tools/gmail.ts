/** Gmail tools. `gmail.send_draft` runs only after the staging gate approves it. */

import {
  GOOGLE_SCOPE,
  GMAIL_SEARCH_SNIPPET_MAX_CHARS,
  collapseWhitespace,
  gmailReadMessageInput,
  gmailSearchInput,
  gmailSearchResultSchema,
  gmailSendDraftInput,
  parseGmailDocumentMetadata,
  restPassthroughInput,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { type ExtractedMessage, extractMessageContent } from "@alfred/integrations/google";
import { and, eq, inArray } from "drizzle-orm";
import { runRestPassthrough } from "./passthrough";
import { liveTool, type RegisteredTool } from "@alfred/assistant/tool-runtime";
import { assertGmailRecipientsAllowed } from "./gmail-recipient-policy";

/** Gmail picks the active account itself, so the URL needs no account index. */
function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

const GMAIL_READ_SCOPES = [GOOGLE_SCOPE.gmail.readonly, GOOGLE_SCOPE.gmail.modify] as const;

function truncateSnippet(text: string | null): string | null {
  if (!text) return null;
  const collapsed = collapseWhitespace(text);

  if (!collapsed) return null;

  return collapsed.length > GMAIL_SEARCH_SNIPPET_MAX_CHARS
    ? `${collapsed.slice(0, GMAIL_SEARCH_SNIPPET_MAX_CHARS - 1)}…`
    : collapsed;
}

export const gmailTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "gmail",
    action: "search",
    riskTier: "no_risk",
    description:
      "Search Gmail messages using Gmail query operators. Each hit carries the headers needed to " +
      "identify it without a follow-up read: `from` (sender), `subject`, `snippet`, `authoredAt`, " +
      "plus `messageId`/`threadId` (pass `messageId` straight to gmail.read_message) and a " +
      "`documentId` when the message has been ingested. Use `from`/`subject` to pick the right hit — " +
      "don't infer a sender from the query.",
    discovery: {
      aliases: ["search email", "find email", "search inbox"],
      tags: ["email", "inbox", "communication"],
      entities: ["email", "message", "thread"],
      verbs: ["search", "find", "list"],
      relatedTools: ["gmail.read_message"],
    },
    availability: {
      credential: { provider: "google", anyOfScopes: GMAIL_READ_SCOPES },
    },
    inputSchema: gmailSearchInput,
    execute: async (input, ctx) => {
      const credential = await ctx.integrations.google.gmail.readCredential();

      const result = await ctx.integrations.google.gmail.listMessages({
        credentialId: credential.id,
        q: input.q,
        maxResults: input.maxResults,
        pageToken: input.pageToken,
      });

      const messageIds = result.messages.map((m) => m.id).filter((id) => id.length > 0);

      const cachedRows =
        messageIds.length > 0
          ? await db()
              .select({
                id: documents.id,
                sourceId: documents.sourceId,
                title: documents.title,
                authoredAt: documents.authoredAt,
                url: documents.url,
                metadata: documents.metadata,
              })
              .from(documents)
              .where(
                and(
                  eq(documents.userId, ctx.userId),
                  eq(documents.source, "gmail"),
                  ctx.accountRef ? eq(documents.accountId, ctx.accountRef) : undefined,
                  inArray(documents.sourceId, messageIds),
                ),
              )
          : [];

      const cachedBySourceId = new Map(
        cachedRows
          .filter((row) => row.sourceId !== null)
          .map((row) => [row.sourceId!, row] as const),
      );

      // `messages.list` returns only ids. Fill headers from the `documents` cache, and
      // fetch them live for uncached hits. A failed fetch leaves nulls.
      const uncachedIds = messageIds.filter((id) => !cachedBySourceId.has(id));
      const liveBySourceId = new Map<string, ExtractedMessage>();

      if (uncachedIds.length > 0) {
        const settled = await Promise.allSettled(
          uncachedIds.map((id) =>
            ctx.integrations.google.gmail.getMessage({
              credentialId: credential.id,
              id,
              format: "metadata",
            }),
          ),
        );

        for (const outcome of settled) {
          if (outcome.status === "fulfilled") {
            liveBySourceId.set(outcome.value.id, extractMessageContent(outcome.value));
          }
        }
      }

      return gmailSearchResultSchema.parse({
        query: input.q,
        messages: result.messages.map((m) => {
          const cached = cachedBySourceId.get(m.id);
          const live = liveBySourceId.get(m.id);
          const metadata = cached ? parseGmailDocumentMetadata(cached.metadata) : null;
          const fromMeta = metadata?.from ?? null;
          const snippetMeta = metadata?.snippet ?? null;

          return {
            messageId: m.id,
            threadId: m.threadId,
            documentId: cached?.id ?? null,
            from: fromMeta ?? live?.from ?? null,
            subject: cached?.title ?? live?.subject ?? null,
            snippet: truncateSnippet(snippetMeta ?? live?.body ?? null),
            authoredAt: (cached?.authoredAt ?? live?.date)?.toISOString() ?? null,
            url: cached?.url ?? null,
          };
        }),
        nextPageToken: result.nextPageToken ?? null,
      });
    },
  }),
  liveTool({
    integration: "gmail",
    action: "read_message",
    riskTier: "low",
    description:
      "Read the full text and metadata for one Gmail message. Pass the `messageId` from a " +
      "gmail.search hit (or a `documentId` for an ingested message). Reads the cached copy when " +
      "ingested, otherwise fetches it live from Gmail — so it works on fresh search results too.",
    discovery: {
      aliases: ["read email", "open email", "read message"],
      tags: ["email", "inbox", "communication"],
      entities: ["email", "message"],
      verbs: ["read", "open", "get"],
      relatedTools: ["gmail.search", "gmail.send_draft"],
    },
    availability: {
      credential: { provider: "google", anyOfScopes: GMAIL_READ_SCOPES },
    },
    inputSchema: gmailReadMessageInput,
    execute: async (input, ctx) => {
      const where = input.documentId
        ? and(
            eq(documents.userId, ctx.userId),
            eq(documents.source, "gmail"),
            ctx.accountRef ? eq(documents.accountId, ctx.accountRef) : undefined,
            eq(documents.id, input.documentId),
          )
        : and(
            eq(documents.userId, ctx.userId),
            eq(documents.source, "gmail"),
            ctx.accountRef ? eq(documents.accountId, ctx.accountRef) : undefined,
            eq(documents.sourceId, input.messageId!),
          );

      const rows = await db()
        .select({
          id: documents.id,
          sourceId: documents.sourceId,
          sourceThreadId: documents.sourceThreadId,
          title: documents.title,
          content: documents.content,
          authoredAt: documents.authoredAt,
          url: documents.url,
          metadata: documents.metadata,
        })
        .from(documents)
        .where(where)
        .limit(1);

      const row = rows[0];

      if (row) {
        return {
          status: "ok",
          source: "ingested" as const,
          documentId: row.id,
          messageId: row.sourceId,
          threadId: row.sourceThreadId,
          subject: row.title,
          authoredAt: row.authoredAt?.toISOString() ?? null,
          url: row.url,
          metadata: row.metadata,
          content: row.content,
        };
      }

      // Not ingested yet, which is common for fresh search hits. Fetch a provider
      // id live. A missed `documentId` is a real not_found.
      if (input.messageId) {
        const credential = await ctx.integrations.google.gmail.readCredential();

        const message = await ctx.integrations.google.gmail.getMessage({
          credentialId: credential.id,
          id: input.messageId,
          format: "full",
        });

        const extracted = extractMessageContent(message);

        return {
          status: "ok",
          source: "live" as const,
          documentId: null,
          messageId: message.id,
          threadId: message.threadId,
          subject: extracted.subject,
          from: extracted.from,
          to: extracted.to,
          cc: extracted.cc,
          authoredAt: extracted.date?.toISOString() ?? null,
          url: gmailThreadUrl(message.threadId),
          content: extracted.body,
        };
      }

      return {
        status: "not_found",
        documentId: input.documentId ?? null,
        messageId: input.messageId ?? null,
      };
    },
  }),
  liveTool({
    integration: "gmail",
    action: "send_draft",
    riskTier: "high",
    description:
      "Send a Gmail message after the user approves it. Recipients must be the active mailbox or people the user has emailed before.",
    discovery: {
      aliases: ["send email", "reply to email", "draft email"],
      tags: ["email", "communication", "write"],
      entities: ["email", "message", "draft", "reply"],
      verbs: ["send", "reply", "draft", "write"],
      relatedTools: ["gmail.search", "gmail.read_message"],
    },
    availability: {
      credential: { provider: "google", anyOfScopes: [GOOGLE_SCOPE.gmail.send] },
    },
    inputSchema: gmailSendDraftInput,
    execute: async (input, ctx) => {
      // Check the send scope first, so the staging records a re-consent failure.
      const credential = await ctx.integrations.google.gmail.sendCredential();
      await assertGmailRecipientsAllowed({
        userId: ctx.userId,
        activeMailbox: credential.accountLabel,
        input,
      });

      const sent = await ctx.integrations.google.gmail.sendMessage({
        credentialId: credential.id,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        bodyText: input.bodyText,
        threadId: input.threadId,
      });

      return { ok: true, messageId: sent.id, threadId: sent.threadId };
    },
  }),
  liveTool({
    integration: "gmail",
    action: "request",
    riskTier: "no_risk",
    availability: { passthrough: true },
    description:
      "Issue a raw, READ-ONLY Gmail REST call, scoped to the connected user's own mailbox, for anything the curated gmail tools don't cover — most usefully the user's LABELS: GET '/labels' lists them, GET '/labels/{id}' reads one. Gmail's user labels ARE Alfred's own triage tags (e.g. '4: awaiting reply', '5: meeting', '6: fyi'), so this is how you reconcile the live mailbox against Alfred's triage state. Also reachable: GET '/messages', '/messages/{id}', '/threads', '/threads/{id}', '/settings/*'. Pass `method` (GET or HEAD only — writes are rejected at the boundary), a mailbox-relative `path` beginning with '/' (never a full URL; the path is already rooted at the user's own mailbox, so do NOT include '/users/me'), and `query` for parameters (labelIds, q, maxResults, format). This is a raw, unvalidated read: a 404 or empty list may mean your path/params were wrong — NOT that the thing is absent. Correct the path once and retry, or state the uncertainty. Never report a raw empty as a confident zero.",
    discovery: {
      aliases: ["gmail api", "gmail labels", "list gmail labels", "call gmail"],
      tags: ["email", "inbox", "communication", "labels"],
      entities: ["label", "message", "thread", "setting", "triage tag"],
      verbs: ["read", "list", "get", "inspect", "query"],
      relatedTools: ["gmail.search", "gmail.read_message"],
    },
    inputSchema: restPassthroughInput,
    execute: async (input, ctx) => {
      const credential = await ctx.integrations.google.gmail.readCredential();

      return runRestPassthrough(ctx.integrations.google.gmail.passthrough(credential.id), input);
    },
  }),
];
