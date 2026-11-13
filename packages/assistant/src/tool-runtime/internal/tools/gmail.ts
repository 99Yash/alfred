/**
 * The Gmail send tool. The staging gate approves every send. The model reads and labels Gmail
 * through the Gmail MCP server (ADR-0126).
 */

import {
  googleAuthorityScopes,
  gmailSendDraftInput,
  isHttpError,
  parseJsonWith,
  type GmailSendDraftInput,
} from "@alfred/contracts";
import { AppError } from "@alfred/contracts/app-errors";
import type { SentMessage } from "@alfred/integrations/google";
import { logger } from "@alfred/logging";
import { z } from "zod";
import {
  liveTool,
  type RegisteredTool,
  type ToolExecuteContext,
} from "@alfred/assistant/tool-runtime";
import { assertGmailRecipientsAllowed } from "./gmail-recipient-policy";

/**
 * The draft that `gmail.send_draft` sends, kept as the call's provider ref. Gmail replaces a
 * caller's `Message-ID`, so the draft id is the only key that a rerun can find.
 */
const sendDraftRefSchema = z.object({
  /** The mailbox that holds the draft. A rerun may select another account, so keep this one. */
  credentialId: z.string().min(1),
  draftId: z.string().min(1),
  threadId: z.string().min(1),
  /** Epoch ms on Alfred's clock, just before the draft was saved. Not Gmail's clock. */
  alfredSavedAt: z.number(),
});

type SendDraftRef = z.infer<typeof sendDraftRefSchema>;

/** Alfred's clock and Gmail's `internalDate` clock can differ by this much. */
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
  const alfredSavedAt = Date.now();

  const draft = await gmail.createDraft({
    credentialId,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    bodyText: input.bodyText,
    threadId: input.threadId,
  });

  const own: SendDraftRef = {
    credentialId,
    draftId: draft.draftId,
    threadId: draft.threadId,
    alfredSavedAt,
  };

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
 * the sent message gets a new id in the draft's thread. A reply thread can hold other sent mail,
 * so take the SENT message nearest to the save.
 */
async function sentFromDraft(
  ref: SendDraftRef,
  ctx: ToolExecuteContext,
): Promise<SentMessage | null> {
  let thread;

  try {
    thread = await ctx.integrations.google.gmail.getThread({
      credentialId: ref.credentialId,
      threadId: ref.threadId,
      format: "minimal",
    });
  } catch (err) {
    if (isHttpError(err) && err.status === 404) return null;

    throw err;
  }

  const distance = (message: { internalDate?: string | undefined }) =>
    Math.abs(Number(message.internalDate) - ref.alfredSavedAt);

  const [sent] = (thread.messages ?? [])
    .filter(
      (message) =>
        (message.labelIds ?? []).includes("SENT") &&
        Number(message.internalDate) >= ref.alfredSavedAt - SENT_CLOCK_SKEW_MS,
    )
    .toSorted((a, b) => distance(a) - distance(b));

  return sent ? { id: sent.id, threadId: sent.threadId } : null;
}

/**
 * Save the mail as a draft, keep the draft id on the staging row, then send the draft. A rerun
 * sends the kept draft. If an earlier attempt sent it, Gmail answers 404 and sends nothing, and
 * the tool returns the message that the earlier attempt sent.
 */
async function executeSendDraft(input: GmailSendDraftInput, ctx: ToolExecuteContext) {
  // The send grant is the user's consent to send. Check it first, so the staging records a
  // re-consent failure. The credential also holds the modify grant that the draft calls use.
  const credential = await ctx.integrations.google.gmail.sendCredential();
  await assertGmailRecipientsAllowed({
    userId: ctx.userId,
    activeMailbox: credential.accountLabel,
    input,
  });

  const draft = await draftForCall(input, ctx, credential.id);
  let sent: SentMessage | null;

  try {
    sent = await ctx.integrations.google.gmail.sendDraft({
      credentialId: draft.credentialId,
      draftId: draft.draftId,
    });
  } catch (err) {
    if (!isHttpError(err) || err.status !== 404) throw err;

    sent = await sentFromDraft(draft, ctx);
  }

  if (!sent) throw new AppError("gmail_draft_gone");

  return { ok: true, messageId: sent.id, threadId: sent.threadId };
}

export const gmailTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "gmail",
    action: "send_draft",
    riskTier: "high",
    // The call keeps its Gmail draft id, and a draft sends once, so a repeat sends no second mail.
    replay: "safe",
    description:
      "Send a Gmail message after the user approves it. Recipients must be the active mailbox or people the user has emailed before. To save a draft without sending, use the Gmail MCP server.",
    discovery: {
      aliases: ["send email", "reply to email"],
      tags: ["email", "communication", "write"],
      entities: ["email", "message", "reply"],
      verbs: ["send", "reply", "write"],
    },
    // One account must hold both grants: the draft calls need modify, and send is the consent.
    availability: {
      credential: {
        provider: "google",
        anyOfScopes: googleAuthorityScopes("gmail_modify"),
        alsoAnyOfScopes: [googleAuthorityScopes("gmail_send")],
      },
    },
    inputSchema: gmailSendDraftInput,
    execute: executeSendDraft,
  }),
];
