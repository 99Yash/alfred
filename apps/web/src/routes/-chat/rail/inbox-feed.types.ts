import type { TriageCategory } from "@alfred/contracts";
import type { SyncedTriageTag } from "@alfred/sync";
import type { RailInboxItem } from "./models";
import type { InboxPagination } from "./rail-data";

export interface InboxFeedProps {
  items: ReadonlyArray<RailInboxItem>;
  /** Optional server-driven pagination. When omitted, local filtering still
   * supports a single page (no controls shown) - used by preview routes. */
  pagination?: InboxPagination;
  /** Document id of the row currently expanded in the reader pane. When
   * non-null, the feed swaps the list out for `InboxDetailPane`. */
  selectedId?: string | null;
  /** Open the reader for a given row. Rendered as a link to Gmail when omitted. */
  onOpen?: (documentId: string) => void;
  /** Close the reader and return to the list. */
  onClose?: () => void;
  /**
   * Optional bulk "mark read" - when present, the feed renders a
   * "Mark all read" affordance that fires with the *visible* unread
   * ids. Preview routes (and any caller that wants to suppress the
   * action) omit this. */
  onMarkRead?: (documentIds: ReadonlyArray<string>) => void;
  /** True while a mark-read request is in flight - disables the button. */
  markReadPending?: boolean;
  /** Synced tag rows keyed by Gmail thread id; overlays optimistic overrides. */
  triageTagsByThreadId?: ReadonlyMap<string, SyncedTriageTag>;
  /** Pin a thread to a user-chosen triage category. */
  onOverrideTag?: (threadId: string, category: TriageCategory) => void;
}
