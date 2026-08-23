import type { AttentionBand, TriageCategory, TriageTagSource } from "@alfred/contracts";
import type { AppTint } from "~/lib/tints";
import type { IntegrationBrand } from "~/lib/integrations/integration-icons";

export type ChatSidePanelMode = "inline" | "overlay";
export type RailTab = "todo" | "inbox" | "meetings";

export interface RailTodoItem {
  id: string;
  title: string;
  due?: string | undefined;
  source?: "email" | "meeting" | "manual" | undefined;
  done?: boolean | undefined;
}

export interface RailInboxItem {
  id: string;
  sender: string;
  /** Bare sender email used for bulk-sender detection and recurrence grouping. */
  senderAddress?: string | null | undefined;
  subject: string;
  preview: string;
  time: string;
  /** Authored time as epoch ms, distinct from the localized display string. */
  authoredAtMs?: number | null | undefined;
  unread?: boolean | undefined;
  initial: string;
  tone: AppTint;
  threadId?: string | null | undefined;
  category?: TriageCategory | null | undefined;
  categorySource?: TriageTagSource | null | undefined;
  attentionBand?: AttentionBand | null | undefined;
  senderBrand?: IntegrationBrand | null | undefined;
  senderDomain?: string | null | undefined;
}

export interface RailMeetingItem {
  id: string;
  title: string;
  time: string;
  duration: string;
  with: string;
  status?: "now" | "next" | "later" | undefined;
}
