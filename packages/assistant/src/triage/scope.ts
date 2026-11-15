import type { MailFacts } from "../knowledge";
import { extractGmailSignals } from "./observations";

/**
 * Where a mail sits when triage does not label it (`docs/theory/triage.md` § What triage tags),
 * with what each value means in the words that the briefing composer reads. Triage labels inbox
 * mail in the Primary and Updates tabs only. The briefing reads every mail, and it gets this value
 * so that it can say where a mail is (a real matter in spam).
 */
export const TRIAGE_OUT_OF_SCOPE_MEANING = {
  spam: "Gmail filed it as spam",
  not_in_inbox: "it is not in the inbox, for example because a Gmail filter skipped the inbox",
  social: "it is in the Social tab",
  promotions: "it is in the Promotions tab",
  forums: "it is in the Forums tab",
  to_yourself: "the user sent it from their own address to their own addresses only",
} as const;

export type TriageOutOfScope = keyof typeof TRIAGE_OUT_OF_SCOPE_MEANING;

/** The Gmail tabs that triage does not label, as `extractGmailSignals` names them. */
const SKIPPED_TABS = [
  "social",
  "promotions",
  "forums",
] as const satisfies readonly TriageOutOfScope[];

type ScopeFacts = Pick<MailFacts, "labelIds" | "sender" | "to" | "cc" | "bcc">;

/**
 * Null when triage labels the mail. The labels are the ones stored at ingest. A mail that the user
 * moves into Primary later is in scope only when Alfred sees the change (triage plan, slice 5).
 */
export function triageOutOfScope(facts: ScopeFacts): TriageOutOfScope | null {
  const gmail = extractGmailSignals(facts.labelIds);

  if (gmail.spam) return "spam";

  if (!gmail.inInbox) return "not_in_inbox";

  const tab = SKIPPED_TABS.find((name) => gmail.categories.includes(name));

  if (tab) return tab;

  const recipients = [...(facts.to ?? []), ...(facts.cc ?? []), ...(facts.bcc ?? [])];

  if (facts.sender.isUser && recipients.length > 0 && recipients.every((r) => r.isUser)) {
    return "to_yourself";
  }

  return null;
}
