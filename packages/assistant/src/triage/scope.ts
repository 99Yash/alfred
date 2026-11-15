import type { MailFacts } from "../knowledge";

/**
 * Where a mail sits when triage does not label it (`docs/theory/triage.md` § What triage tags).
 * Triage labels inbox mail in the Primary and Updates tabs only. The briefing reads every mail,
 * and it gets this value so that it can say where a mail is (a real matter in spam).
 *
 * - `spam`: Gmail filed the mail as spam.
 * - `not_in_inbox`: the mail has no `INBOX` label, for example because a Gmail filter skipped it.
 * - `social`, `promotions`, `forums`: the Gmail tab of the mail.
 * - `to_yourself`: the user sent it from one of their addresses to their addresses only.
 */
export type TriageOutOfScope =
  | "spam"
  | "not_in_inbox"
  | "social"
  | "promotions"
  | "forums"
  | "to_yourself";

/** The Gmail tabs that triage does not label, by their label id. */
const SKIPPED_TABS: ReadonlyMap<string, TriageOutOfScope> = new Map([
  ["CATEGORY_SOCIAL", "social"],
  ["CATEGORY_PROMOTIONS", "promotions"],
  ["CATEGORY_FORUMS", "forums"],
]);

type ScopeFacts = Pick<MailFacts, "labelIds" | "sender" | "to" | "cc" | "bcc">;

/**
 * Null when triage labels the mail. The labels are the ones stored at ingest. A mail that the user
 * moves into Primary later is in scope only when Alfred sees the change (triage plan, slice 5).
 */
export function triageOutOfScope(facts: ScopeFacts): TriageOutOfScope | null {
  const labels = new Set(facts.labelIds);

  if (labels.has("SPAM")) return "spam";

  if (!labels.has("INBOX")) return "not_in_inbox";

  const tab = facts.labelIds.flatMap((id) => SKIPPED_TABS.get(id) ?? [])[0];

  if (tab) return tab;

  const recipients = [...(facts.to ?? []), ...(facts.cc ?? []), ...(facts.bcc ?? [])];

  if (facts.sender.isUser && recipients.length > 0 && recipients.every((r) => r.isUser)) {
    return "to_yourself";
  }

  return null;
}
