/**
 * `gmail.send_draft` sends live mail despite its name. Approval alone cannot stop an
 * injected message from naming a new address, so only the mailbox itself or a person
 * the user has emailed before may receive it. Inbound-only rows do not count:
 * an attacker creates one by sending one message.
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

/** Throw before Gmail is called when any recipient is new. The loader is injectable for tests. */
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
