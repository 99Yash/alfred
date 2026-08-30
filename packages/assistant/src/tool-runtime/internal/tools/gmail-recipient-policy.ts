/**
 * Recipient policy for the live-send path behind `gmail.send_draft` (#134).
 *
 * The action name is historical: the tool sends live mail. Approval remains a
 * hard floor, but approval alone does not stop an injected inbound message from
 * choosing a new exfiltration address. The final execute boundary therefore
 * permits only the active mailbox or a person the user has emailed before.
 *
 * An inbound-only person row is deliberately insufficient. Passive Gmail
 * capture creates those rows, so treating every row as "known" would let an
 * attacker place their own address on the allow-list by sending one message.
 */

import {
  getPath,
  parseEmailAddress,
  toStringArray,
  type GmailSendDraftInput,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { entities, type Entity } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

type PersonContactEvidence = Pick<Entity, "aliases" | "metadata">;
type SendDraftRecipients = Pick<GmailSendDraftInput, "to" | "cc" | "bcc">;
type LoadPersonContactEvidence = (userId: string) => Promise<readonly PersonContactEvidence[]>;

const priorOutboundCountSchema = z.number().int().positive();

async function loadPersonContactEvidence(userId: string): Promise<PersonContactEvidence[]> {
  return db()
    .select({ aliases: entities.aliases, metadata: entities.metadata })
    .from(entities)
    .where(and(eq(entities.userId, userId), eq(entities.kind, "person")));
}

function normalizedRecipients(input: SendDraftRecipients): Set<string> {
  const recipients = new Set<string>();
  for (const value of [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]) {
    const normalized = parseEmailAddress(value);
    if (!normalized) {
      throw new Error("[gmail.recipient_policy] recipient failed canonical validation");
    }
    recipients.add(normalized);
  }
  return recipients;
}

function addPreviouslyContactedAliases(
  allowed: Set<string>,
  rows: readonly PersonContactEvidence[],
): void {
  for (const row of rows) {
    const outbound = priorOutboundCountSchema.safeParse(
      getPath(row.metadata, "correspondence", "outbound"),
    );
    if (!outbound.success) continue;

    for (const alias of toStringArray(row.aliases)) {
      const normalized = parseEmailAddress(alias);
      if (normalized) allowed.add(normalized);
    }
  }
}

/**
 * Fail closed before Gmail is called when any live-send recipient is new.
 * The loader is injectable so the policy branches can be tested without a DB.
 */
export async function assertGmailRecipientsAllowed(
  args: {
    userId: string;
    activeMailbox: string | null;
    input: SendDraftRecipients;
  },
  loadContacts: LoadPersonContactEvidence = loadPersonContactEvidence,
): Promise<void> {
  const requested = normalizedRecipients(args.input);
  const allowed = new Set<string>();
  const activeMailbox = parseEmailAddress(args.activeMailbox);
  if (activeMailbox) allowed.add(activeMailbox);

  const contacts = await loadContacts(args.userId);
  addPreviouslyContactedAliases(allowed, contacts);

  const denied = [...requested].filter((recipient) => !allowed.has(recipient));
  if (denied.length === 0) return;

  throw new Error(
    `[gmail.recipient_policy] live send blocked for new recipient(s): ${denied.join(", ")}. ` +
      "Alfred can send only to the active mailbox or to a person you have emailed before.",
  );
}
