/** Gmail tools. Every write runs only after the staging gate approves it. */

import {
  GMAIL_SEARCH_SNIPPET_MAX_CHARS,
  collapseWhitespace,
  googleAuthorityScopes,
  gmailGetThreadInput,
  gmailModifyMessageInput,
  gmailModifyThreadInput,
  gmailReadMessageInput,
  gmailSearchInput,
  gmailSearchResultSchema,
  gmailSendDraftInput,
  gmailThreadUrl,
  isHttpError,
  parseGmailDocumentMetadata,
  parseJsonWith,
  restPassthroughInput,
  type GmailModifyMessageInput,
  type GmailModifyThreadInput,
  type GmailSendDraftInput,
  type ToolRiskTier,
} from "@alfred/contracts";
import { AppError } from "@alfred/contracts/app-errors";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { gmailMailboxWritesEnabled } from "@alfred/env/server";
import {
  type ExtractedMessage,
  type GmailLabel,
  type GoogleClient,
  TRIAGE_CATEGORIES,
  extractMessageContent,
  labelNameFor,
} from "@alfred/integrations/google";
import { logger } from "@alfred/logging";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { runRestPassthrough } from "./passthrough";
import {
  liveTool,
  type RegisteredTool,
  type ToolExecuteContext,
} from "@alfred/assistant/tool-runtime";
import { assertGmailRecipientsAllowed } from "./gmail-recipient-policy";

/** Gmail empties Trash after 30 days, and a spam mark trains Google's filter. */
const DESTRUCTIVE_LABEL_IDS: ReadonlySet<string> = new Set(["TRASH", "SPAM"]);

/** The label edit that `modify_thread` and `modify_message` share. */
type GmailLabelChange = Pick<
  GmailModifyThreadInput | GmailModifyMessageInput,
  "addLabels" | "removeLabels"
>;

function labelChangeNames(input: GmailLabelChange): string[] {
  return [...(input.addLabels ?? []), ...(input.removeLabels ?? [])];
}

export function resolveGmailLabelChangeRiskTier(input: GmailLabelChange): ToolRiskTier {
  const trashesOrSpams = (input.addLabels ?? []).some((name) =>
    DESTRUCTIVE_LABEL_IDS.has(name.toUpperCase()),
  );

  return trashesOrSpams ? "high" : "medium";
}

/**
 * Alfred's triage owns its numbered labels, and the history sync reads only added mail, so a
 * label change from here would never reach the triage state. Case-folded, because
 * {@link findLabel} matches a name without case.
 */
const TRIAGE_LABEL_NAMES: ReadonlySet<string> = new Set(
  TRIAGE_CATEGORIES.map((category) => labelNameFor(category).toLowerCase()),
);

function triageLabelMessage(names: readonly string[]): string {
  return (
    `${names.join(", ")} ${names.length === 1 ? "is" : "are"} Alfred's triage labels. ` +
    "Triage owns them, so this tool does not change them. Change the other labels only."
  );
}

function refuseGmailLabelChange(input: GmailLabelChange): string | null {
  if (!gmailMailboxWritesEnabled()) {
    return "Gmail mailbox writes are off in this environment, so the labels did not change.";
  }

  const triageLabels = labelChangeNames(input).filter((name) =>
    TRIAGE_LABEL_NAMES.has(name.toLowerCase()),
  );

  return triageLabels.length > 0 ? triageLabelMessage(triageLabels) : null;
}

/** A system label's id is its name (`INBOX`), so an id match and a name match are one lookup. */
function findLabel(labels: readonly GmailLabel[], name: string): GmailLabel | undefined {
  const folded = name.toLowerCase();

  return (
    labels.find((label) => label.id === name || label.name === name) ??
    labels.find((label) => label.name.toLowerCase() === folded)
  );
}

type ResolvedLabelChange = {
  labels: GmailLabel[];
  addLabelIds: string[];
  removeLabelIds: string[];
  createdLabels: string[];
  notFound: string[];
};

/**
 * Names to ids, before any write. A missing added label is created; a missing removed label is
 * reported, not created.
 */
async function resolveLabelChange(
  gmail: GoogleClient["gmail"],
  credentialId: string,
  input: GmailLabelChange,
): Promise<ResolvedLabelChange> {
  const labels = await gmail.listLabels(credentialId);

  const adds = (input.addLabels ?? []).map((name) => ({
    name,
    label: findLabel(labels, name),
  }));

  const removes = (input.removeLabels ?? []).map((name) => ({
    name,
    label: findLabel(labels, name),
  }));

  // A label id passes the name refusal, so check what each name resolved to before any write.
  const triageLabels = [...adds, ...removes]
    .flatMap(({ label }) => (label ? [label.name] : []))
    .filter((name) => TRIAGE_LABEL_NAMES.has(name.toLowerCase()));

  if (triageLabels.length > 0) throw new AppError("gmail_triage_label_refused");

  const createdLabels: string[] = [];
  const addLabelIds: string[] = [];

  for (const { name, label } of adds) {
    if (label) {
      addLabelIds.push(label.id);
      continue;
    }

    const createdLabel = await gmail.createLabel({ credentialId, name });
    labels.push(createdLabel);
    createdLabels.push(createdLabel.name);
    addLabelIds.push(createdLabel.id);
  }

  return {
    labels,
    addLabelIds,
    removeLabelIds: removes.flatMap(({ label }) => (label ? [label.id] : [])),
    createdLabels,
    notFound: removes.flatMap(({ name, label }) => (label ? [] : [name])),
  };
}

function labelNamesFor(labels: readonly GmailLabel[], ids: Iterable<string>): string[] {
  const names = new Map(labels.map((label) => [label.id, label.name] as const));

  return [...ids].map((id) => names.get(id) ?? id);
}

function truncateSnippet(text: string | null): string | null {
  if (!text) return null;
  const collapsed = collapseWhitespace(text);

  if (!collapsed) return null;

  return collapsed.length > GMAIL_SEARCH_SNIPPET_MAX_CHARS
    ? `${collapsed.slice(0, GMAIL_SEARCH_SNIPPET_MAX_CHARS - 1)}…`
    : collapsed;
}

/**
 * The draft that `gmail.send_draft` sends, kept as the call's provider ref. Gmail replaces a
 * caller's `Message-ID`, so the draft id is the only key that a rerun can find.
 */
const sendDraftRefSchema = z.object({
  draftId: z.string().min(1),
  threadId: z.string().min(1),
  /** Epoch ms, just before the draft was saved. */
  savedAt: z.number(),
});

type SendDraftRef = z.infer<typeof sendDraftRefSchema>;

/** Our clock and Gmail's `internalDate` can differ by this much. */
const SENT_CLOCK_SKEW_MS = 60_000;

function parseSendDraftRef(raw: string): SendDraftRef {
  const ref = parseJsonWith(raw, sendDraftRefSchema);

  // Fail closed: a new draft could send the mail a second time.
  if (ref === null) throw new Error("[gmail.send_draft] stored provider ref does not parse");

  return ref;
}

/**
 * The draft of this call. A rerun gets the draft that an earlier attempt kept. Two attempts that
 * both save a draft keep the first one, and the other attempt deletes its own.
 */
async function draftForCall(
  input: GmailSendDraftInput,
  ctx: ToolExecuteContext,
  credentialId: string,
): Promise<SendDraftRef> {
  const slot = ctx.providerRef;

  // Always staged, so a missing slot is a wiring bug.
  if (!slot) throw new Error("gmail.send_draft executed without a staging row");

  const kept = await slot.read();

  if (kept !== null) return parseSendDraftRef(kept);

  const gmail = ctx.integrations.google.gmail;
  const savedAt = Date.now();

  const draft = await gmail.createDraft({
    credentialId,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    bodyText: input.bodyText,
    threadId: input.threadId,
  });

  const own: SendDraftRef = { draftId: draft.draftId, threadId: draft.threadId, savedAt };
  const winner = parseSendDraftRef(await slot.record(JSON.stringify(own)));

  if (winner.draftId !== own.draftId) {
    await gmail.deleteDraft({ credentialId, draftId: own.draftId }).catch((err: unknown) => {
      logger.warn(
        { err, runId: ctx.runId, toolCallId: ctx.toolCallId },
        "[gmail.send_draft] could not delete a duplicate draft",
      );
    });
  }

  return winner;
}

/**
 * The message that an earlier attempt sent from this draft. Gmail deletes a draft on send, and
 * the sent message gets a new id in the draft's thread.
 */
async function sentFromDraft(
  ref: SendDraftRef,
  ctx: ToolExecuteContext,
  credentialId: string,
): Promise<{ id: string; threadId: string } | null> {
  let thread;

  try {
    thread = await ctx.integrations.google.gmail.getThread({
      credentialId,
      threadId: ref.threadId,
      format: "minimal",
    });
  } catch (err) {
    if (isHttpError(err) && err.status === 404) return null;

    throw err;
  }

  const sent = (thread.messages ?? []).find(
    (message) =>
      (message.labelIds ?? []).includes("SENT") &&
      Number(message.internalDate) >= ref.savedAt - SENT_CLOCK_SKEW_MS,
  );

  return sent ? { id: sent.id, threadId: sent.threadId } : null;
}

/**
 * Save the mail as a draft, keep the draft id on the staging row, then send the draft. A rerun
 * sends the kept draft. If an earlier attempt sent it, Gmail answers 404 and sends nothing, and
 * the tool returns the message that the earlier attempt sent.
 */
async function executeSendDraft(input: GmailSendDraftInput, ctx: ToolExecuteContext) {
  // Check the send scope first, so the staging records a re-consent failure.
  const credential = await ctx.integrations.google.gmail.sendCredential();
  await assertGmailRecipientsAllowed({
    userId: ctx.userId,
    activeMailbox: credential.accountLabel,
    input,
  });

  const draft = await draftForCall(input, ctx, credential.id);

  try {
    const sent = await ctx.integrations.google.gmail.sendDraft({
      credentialId: credential.id,
      draftId: draft.draftId,
    });

    return { ok: true, messageId: sent.id, threadId: sent.threadId };
  } catch (err) {
    if (!isHttpError(err) || err.status !== 404) throw err;
  }

  const sent = await sentFromDraft(draft, ctx, credential.id);

  if (!sent) throw new AppError("gmail_draft_gone");

  return { ok: true, messageId: sent.id, threadId: sent.threadId };
}

export const gmailTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "gmail",
    action: "search",
    riskTier: "no_risk",
    replay: "safe",
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
      credential: { provider: "google", anyOfScopes: googleAuthorityScopes("gmail") },
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

      const cachedBySourceId = new Map(cachedRows.map((row) => [row.sourceId, row] as const));

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
    replay: "safe",
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
      credential: { provider: "google", anyOfScopes: googleAuthorityScopes("gmail") },
    },
    inputSchema: gmailReadMessageInput,
    execute: async (input, ctx) => {
      const lookup = input.documentId
        ? eq(documents.id, input.documentId)
        : input.messageId
          ? eq(documents.sourceId, input.messageId)
          : undefined;

      // The schema's refine requires one of the two ids. Without one, the query would match any message.
      if (!lookup)
        throw new Error("gmail.read_message: input has neither documentId nor messageId");

      const where = and(
        eq(documents.userId, ctx.userId),
        eq(documents.source, "gmail"),
        ctx.accountRef ? eq(documents.accountId, ctx.accountRef) : undefined,
        lookup,
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
          url: gmailThreadUrl({ threadId: message.threadId, mailbox: credential.accountLabel }),
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
    action: "get_thread",
    riskTier: "low",
    replay: "safe",
    description:
      "Read a whole Gmail thread in order: each message's sender, recipients, date, unread state " +
      "and body, plus the thread's label names. Pass a `threadId` from gmail.search.",
    discovery: {
      aliases: ["read thread", "read conversation", "email thread"],
      tags: ["email", "inbox", "communication"],
      entities: ["email", "thread", "conversation", "label"],
      verbs: ["read", "open", "get"],
      relatedTools: ["gmail.search", "gmail.modify_thread", "gmail.create_draft"],
    },
    availability: {
      credential: { provider: "google", anyOfScopes: googleAuthorityScopes("gmail") },
    },
    inputSchema: gmailGetThreadInput,
    execute: async (input, ctx) => {
      const gmail = ctx.integrations.google.gmail;
      const credential = await gmail.readCredential();

      const [thread, labels] = await Promise.all([
        gmail.getThread({
          credentialId: credential.id,
          threadId: input.threadId,
          format: input.format,
        }),
        gmail.listLabels(credential.id),
      ]);

      const labelNames = new Map(labels.map((label) => [label.id, label.name] as const));
      const messages = thread.messages ?? [];
      const threadLabelIds = new Set(messages.flatMap((message) => message.labelIds ?? []));

      return {
        threadId: thread.id,
        url: gmailThreadUrl({ threadId: thread.id, mailbox: credential.accountLabel }),
        labels: [...threadLabelIds].map((id) => labelNames.get(id) ?? id),
        messageCount: messages.length,
        messages: messages.map((message) => {
          const extracted = extractMessageContent(message);

          return {
            messageId: message.id,
            from: extracted.from,
            to: extracted.to,
            cc: extracted.cc,
            subject: extracted.subject,
            authoredAt: extracted.date?.toISOString() ?? null,
            unread: message.labelIds?.includes("UNREAD") ?? false,
            ...(input.format === "full"
              ? { body: extracted.body }
              : { snippet: truncateSnippet(message.snippet ?? null) }),
          };
        }),
      };
    },
  }),
  liveTool({
    integration: "gmail",
    action: "modify_thread",
    riskTier: "medium",
    replay: "safe",
    description:
      "Add or remove labels on every message of a Gmail thread, by label name. A missing user " +
      "label is created. System labels do the mailbox actions: remove INBOX to archive, " +
      "UNREAD to mark read, add STARRED to star, TRASH to trash, SPAM to report spam. Alfred's " +
      "numbered triage labels are refused.",
    discovery: {
      aliases: ["label email", "archive email", "trash email", "mark as read", "star email"],
      tags: ["email", "inbox", "labels", "write"],
      entities: ["email", "thread", "label", "inbox", "trash", "spam"],
      verbs: ["label", "archive", "trash", "delete", "star", "mark", "move"],
      relatedTools: ["gmail.search", "gmail.get_thread"],
    },
    availability: {
      credential: { provider: "google", anyOfScopes: googleAuthorityScopes("gmail_modify") },
    },
    inputSchema: gmailModifyThreadInput,
    resolveRiskTier: (input) => Promise.resolve(resolveGmailLabelChangeRiskTier(input)),
    refuseInput: (input) => refuseGmailLabelChange(input),
    execute: async (input, ctx) => {
      const gmail = ctx.integrations.google.gmail;
      const credential = await gmail.modifyCredential();
      const change = await resolveLabelChange(gmail, credential.id, input);
      const { createdLabels, notFound } = change;

      if (change.addLabelIds.length === 0 && change.removeLabelIds.length === 0) {
        return { ok: true, threadId: input.threadId, changed: false, notFound };
      }

      const thread = await gmail.modifyThreadLabels({
        credentialId: credential.id,
        threadId: input.threadId,
        addLabelIds: change.addLabelIds,
        removeLabelIds: change.removeLabelIds,
      });

      const threadLabelIds = new Set(
        (thread.messages ?? []).flatMap((message) => message.labelIds ?? []),
      );

      return {
        ok: true,
        threadId: thread.id,
        changed: true,
        labels: labelNamesFor(change.labels, threadLabelIds),
        createdLabels,
        notFound,
      };
    },
  }),
  liveTool({
    integration: "gmail",
    action: "modify_message",
    riskTier: "medium",
    replay: "safe",
    description:
      "Add or remove labels on ONE Gmail message, by label name. Use it when only one message " +
      "of a thread must change; gmail.modify_thread changes them all. A missing user label is " +
      "created. System labels do the mailbox actions: remove INBOX to archive, UNREAD to mark " +
      "read, add STARRED to star, TRASH to trash, SPAM to report spam. Remove TRASH to restore " +
      "from trash; remove SPAM and add INBOX to restore from spam. Alfred's numbered triage " +
      "labels are refused.",
    discovery: {
      aliases: ["label message", "trash message", "untrash email", "not spam", "mark message read"],
      tags: ["email", "inbox", "labels", "write"],
      entities: ["email", "message", "label", "inbox", "trash", "spam"],
      verbs: ["label", "archive", "trash", "untrash", "restore", "star", "mark", "move"],
      relatedTools: ["gmail.get_thread", "gmail.modify_thread"],
    },
    availability: {
      credential: { provider: "google", anyOfScopes: googleAuthorityScopes("gmail_modify") },
    },
    inputSchema: gmailModifyMessageInput,
    resolveRiskTier: (input) => Promise.resolve(resolveGmailLabelChangeRiskTier(input)),
    refuseInput: (input) => refuseGmailLabelChange(input),
    execute: async (input, ctx) => {
      const gmail = ctx.integrations.google.gmail;
      const credential = await gmail.modifyCredential();
      const change = await resolveLabelChange(gmail, credential.id, input);
      const { createdLabels, notFound } = change;

      if (change.addLabelIds.length === 0 && change.removeLabelIds.length === 0) {
        return { ok: true, messageId: input.messageId, changed: false, notFound };
      }

      const message = await gmail.modifyMessageLabels({
        credentialId: credential.id,
        messageId: input.messageId,
        addLabelIds: change.addLabelIds,
        removeLabelIds: change.removeLabelIds,
      });

      return {
        ok: true,
        messageId: message.id,
        threadId: message.threadId,
        changed: true,
        labels: labelNamesFor(change.labels, message.labelIds ?? []),
        createdLabels,
        notFound,
      };
    },
  }),
  liveTool({
    integration: "gmail",
    action: "create_draft",
    riskTier: "low",
    replay: "unsafe",
    description:
      "Save a plain-text Gmail draft and send nothing. The user reviews and sends it from Gmail, " +
      "so any recipient is allowed. Pass `threadId` to save a reply draft in that thread.",
    discovery: {
      aliases: ["draft email", "save draft", "write a draft"],
      tags: ["email", "communication", "write"],
      entities: ["email", "draft", "reply"],
      verbs: ["draft", "write", "compose", "save"],
      relatedTools: ["gmail.get_thread", "gmail.send_draft"],
    },
    availability: {
      credential: { provider: "google", anyOfScopes: googleAuthorityScopes("gmail_modify") },
    },
    inputSchema: gmailSendDraftInput,
    execute: async (input, ctx) => {
      const gmail = ctx.integrations.google.gmail;
      const credential = await gmail.modifyCredential();

      const draft = await gmail.createDraft({
        credentialId: credential.id,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        bodyText: input.bodyText,
        threadId: input.threadId,
      });

      return { ok: true, ...draft, url: "https://mail.google.com/mail/u/0/#drafts" };
    },
  }),
  liveTool({
    integration: "gmail",
    action: "send_draft",
    riskTier: "high",
    // The call keeps its Gmail draft id, and a draft sends once, so a repeat sends no second mail.
    replay: "safe",
    description:
      "Send a Gmail message after the user approves it. Recipients must be the active mailbox or people the user has emailed before. To save without sending, use gmail.create_draft.",
    discovery: {
      aliases: ["send email", "reply to email"],
      tags: ["email", "communication", "write"],
      entities: ["email", "message", "reply"],
      verbs: ["send", "reply", "write"],
      relatedTools: ["gmail.search", "gmail.read_message", "gmail.create_draft"],
    },
    availability: {
      credential: { provider: "google", anyOfScopes: googleAuthorityScopes("gmail_send") },
    },
    inputSchema: gmailSendDraftInput,
    execute: executeSendDraft,
  }),
  liveTool({
    integration: "gmail",
    action: "request",
    riskTier: "no_risk",
    replay: "safe",
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
