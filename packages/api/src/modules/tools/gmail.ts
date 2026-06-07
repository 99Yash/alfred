/**
 * Gmail tools registered into the boss's tool surface.
 *
 * `gmail.search` and `gmail.read_message` are low-risk cached/read paths.
 * `gmail.send_draft` sends a plain-text email via `users.messages.send`. The
 * dispatcher only invokes `execute` on the approved-staging resume path for
 * gated tools, so the send only runs after the user (or auto-approver) signs
 * off on the proposed message. Requires the `gmail.send` scope.
 */

import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import {
  getFreshAccessToken,
  listCredentials,
  listMessages,
  requireScopes,
  sendMessage,
} from "@alfred/integrations/google";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { liveTool, type RegisteredTool } from "./registry";

const gmailSearchInput = z
  .object({
    q: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "Gmail search query. Supports the full Gmail operator set (in:, from:, newer_than:, has:, …).",
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Cap on results returned to the model (Gmail allows up to 500; we cap at 50)."),
  })
  .strict();

const gmailSendDraftInput = z
  .object({
    to: z.array(z.string().email()).min(1).max(25),
    cc: z.array(z.string().email()).max(25).optional(),
    bcc: z.array(z.string().email()).max(25).optional(),
    subject: z
      .string()
      .min(1)
      .max(1000)
      .refine((s) => !/[\r\n]/.test(s), {
        message: "subject must not contain line breaks",
      }),
    bodyText: z.string().min(1).max(50_000),
    /**
     * Optional `In-Reply-To` / `References` thread anchor — the dispatcher
     * surfaces this on the approval card so the user can confirm what
     * thread Alfred is replying into.
     */
    threadId: z.string().optional(),
  })
  .strict();

const gmailReadMessageInput = z
  .object({
    documentId: z
      .string()
      .min(1)
      .optional()
      .describe("Alfred document id for an ingested Gmail message. Prefer this when available."),
    messageId: z
      .string()
      .min(1)
      .optional()
      .describe("Provider-native Gmail message id. Use only when no Alfred document id is known."),
  })
  .strict()
  .refine((value) => Boolean(value.documentId || value.messageId), {
    message: "documentId or messageId is required",
  });

async function pickGoogleCredentialId(userId: string): Promise<string> {
  const creds = await listCredentials(userId, "google");
  const active = creds.find((c) => c.status === "active");
  if (!active) {
    throw new Error(
      `[gmail.tools] user ${userId} has no active google credential — reconnect in settings`,
    );
  }
  return active.id;
}

export const gmailTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "gmail",
    action: "search",
    riskTier: "no_risk",
    description:
      "Search Gmail messages using Gmail query operators and return message ids plus cached subject metadata when available.",
    inputSchema: gmailSearchInput,
    execute: async (input, ctx) => {
      const credentialId = await pickGoogleCredentialId(ctx.userId);
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
            id: m.id,
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
    description: "Read the cached full text and metadata for one ingested Gmail message.",
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
      if (!row) {
        return {
          status: "not_found",
          documentId: input.documentId ?? null,
          messageId: input.messageId ?? null,
        };
      }
      return {
        status: "ok",
        documentId: row.id,
        messageId: row.sourceId,
        threadId: row.sourceThreadId,
        subject: row.title,
        authoredAt: row.authoredAt?.toISOString() ?? null,
        url: row.url,
        metadata: row.metadata,
        content: row.content,
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
      const credentialId = await pickGoogleCredentialId(ctx.userId);
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
