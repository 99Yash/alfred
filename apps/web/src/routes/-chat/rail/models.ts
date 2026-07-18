import type { AttentionBand, TriageCategory, TriageTagSource } from "@alfred/contracts";
import { APP_TINTS, type AppTint } from "~/lib/tints";
import type { IntegrationBrand } from "~/lib/integrations/integration-icons";

export type ChatSidePanelMode = "inline" | "overlay";
export type RailTab = "todo" | "inbox" | "meetings";

export interface RailTodoItem {
  id: string;
  title: string;
  due?: string;
  source?: "email" | "meeting" | "manual";
  done?: boolean;
}

export interface RailInboxItem {
  id: string;
  sender: string;
  /** Bare sender email used for bulk-sender detection and recurrence grouping. */
  senderAddress?: string | null;
  subject: string;
  preview: string;
  time: string;
  /** Authored time as epoch ms, distinct from the localized display string. */
  authoredAtMs?: number | null;
  unread?: boolean;
  initial: string;
  tone: RailToolTone;
  threadId?: string | null;
  category?: TriageCategory | null;
  categorySource?: TriageTagSource | null;
  attentionBand?: AttentionBand | null;
  senderBrand?: IntegrationBrand | null;
  senderDomain?: string | null;
}

export interface RailMeetingItem {
  id: string;
  title: string;
  time: string;
  duration: string;
  with: string;
  status?: "now" | "next" | "later";
}

export type RailToolTone = AppTint;

export const RAIL_TOOL_TONE = APP_TINTS;
