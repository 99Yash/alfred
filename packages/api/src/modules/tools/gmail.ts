/**
 * Gmail tools registered into the boss's tool surface.
 *
 * `gmail.search` and `gmail.read_message` are low-risk cached/read paths.
 * `gmail.send_draft` sends a plain-text email via `users.messages.send`. The
 * dispatcher only invokes `execute` on the approved-staging resume path for
 * gated tools, so the send only runs after the user (or auto-approver) signs
 * off on the proposed message. Requires the `gmail.send` scope.
 */

import { gmailReadMessageInput, gmailSearchInput, gmailSendDraftInput } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import {
  extractMessageContent,
  getFreshAccessToken,
  getMessage,
  GMAIL_MODIFY_SCOPE,
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  listCredentials,
  listMessages,
  requireScopes,
  sendMessage,
} from "@alfred/integrations/google";
import { and, eq, inArray } from "drizzle-orm";
import { liveTool, type RegisteredTool } from "./registry";

/**
 * Best-effort Gmail webview URL. Gmail accepts thread ids in the `#all/` path
 * and picks the active account itself, so we don't need to know which account
 * the user is viewing. Mirrors `gmailThreadUrl` in the briefing gather module.
 */
function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

/** Scopes that grant Gmail read access — either readonly or the broader modify. */
const GMAIL_READ_SCOPES = [GMAIL_READONLY_SCOPE, GMAIL_MODIFY_SCOPE] as const;

/**
 * Pick the Google credential to make a Gmail call through.
 *
 * A user can connect several Google accounts, and any one credential may be
 * Calendar/Drive-only (no Gmail scope). "First active" therefore risks a 403
 * (credential without Gmail access) or reading the wrong mailbox. Filter to
 * active credentials that actually grant one of `gmailScopes` and take the
 * first match — readonly/modify for reads, `gmail.send` for sends.
 *
 * Single-account is the norm for Alfred, so we don't disambiguate across
 * multiple Gmail-capable accounts here (the tool surface doesn't thread an
 * explicit accountId yet — that's a future refinement); the first
 * scope-satisfying credential wins.
 */
async function pickGmailCredentialId(
  userId: string,
  gmailScopes: readonly string[],
): Promise<string> {
  const creds = await listCredentials(userId, "google");
  const active = creds.filter((c) => c.status === "active");
  if (active.length === 0) {
    throw new Error(
      `[gmail.tools] user ${userId} has no active google credential — reconnect in settings`,
    );
  }
  const scoped = active.find((c) => {
    const granted = new Set(c.scopes);
    return gmailScopes.some((s) => granted.has(s));
  });
  if (!scoped) {
    throw new Error(
      `[gmail.tools] user ${userId} has ${active.length} active google credential(s) but none grant ` +
        `Gmail access — reconnect with Gmail enabled`,
    );
  }
  return scoped.id;
}

export const gmailTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "gmail",
    action: "search",
    riskTier: "no_risk",
    description:
      "Search Gmail messages using Gmail query operators. Returns each hit's `messageId` " +
      "(pass it straight to gmail.read_message), its `threadId`, and a `documentId` plus cached " +
      "subject metadata when the message has been ingested (documentId may be null for fresh results).",
    inputSchema: gmailSearchInput,
    execute: async (input, ctx) => {
      const credentialId = await pickGmailCredentialId(ctx.userId, GMAIL_READ_SCOPES);
      const accessToken = await getFreshAccessToken(credentialId);
      const result = await listMessages({
        accessToken,
        q: input.q,
        maxResults: input.maxResults,
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
              })
              .from(documents)
              .where(
                and(
                  eq(documents.userId, ctx.userId),
                  eq(documents.source, "gmail"),
                  inArray(documents.sourceId, messageIds),
                ),
              )
          : [];
      const cachedBySourceId = new Map(
        cachedRows
          .filter((row) => row.sourceId !== null)
          .map((row) => [row.sourceId!, row] as const),
      );
      return {
        messages: result.messages.map((m) => {
          const cached = cachedBySourceId.get(m.id);
          return {
            messageId: m.id,
            threadId: m.threadId,
            documentId: cached?.id ?? null,
            subject: cached?.title ?? null,
            authoredAt: cached?.authoredAt?.toISOString() ?? null,
            url: cached?.url ?? null,
          };
        }),
        nextPageToken: result.nextPageToken ?? null,
      };
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
    inputSchema: gmailReadMessageInput,
    execute: async (input, ctx) => {
      const where = input.documentId
        ? and(
            eq(documents.userId, ctx.userId),
            eq(documents.source, "gmail"),
            eq(documents.id, input.documentId),
          )
        : and(
            eq(documents.userId, ctx.userId),
            eq(documents.source, "gmail"),
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

      // Not ingested. `gmail.search` hits the live Gmail API and returns
      // provider message ids that frequently aren't in `documents` (anything
      // not yet ingested), so a cached-only read would return not_found for
      // every fresh search result — the model can list the ids but never read
      // them. When we have a provider message id, fetch it live from Gmail so
      // the search→read flow actually completes. A `documentId` that misses is
      // a genuine not_found (it's our own id; there's nothing live to fetch).
      if (input.messageId) {
        const credentialId = await pickGmailCredentialId(ctx.userId, GMAIL_READ_SCOPES);
        const accessToken = await getFreshAccessToken(credentialId);
        const message = await getMessage({ accessToken, id: input.messageId, format: "full" });
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
    description: "Prepare or send a Gmail draft after the user approves the proposed message.",
    inputSchema: gmailSendDraftInput,
    execute: async (input, ctx) => {
      // The dispatcher only invokes execute on the approved-staging resume
      // path, so reaching here means the user (or auto-approver) signed off
      // on the proposed message. Requires the `gmail.send` scope on the
      // credential; pre-check so the staging records a re-consent failure
      // before making the Gmail send request.
      const credentialId = await pickGmailCredentialId(ctx.userId, [GMAIL_SEND_SCOPE]);
      await requireScopes(credentialId, ["reply_draft"]);
      const accessToken = await getFreshAccessToken(credentialId);
      const sent = await sendMessage({
        accessToken,
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
];
