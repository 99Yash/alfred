import type { ChatModelTier } from "@alfred/contracts";
import type { SyncedChatMessage } from "@alfred/sync";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Brain,
  ClipboardCopy,
  Ellipsis,
  Pencil,
  Pin,
  PinOff,
  ShieldCheck,
  Trash2,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { useAppTheme } from "~/components/ui/v2";
import { formatCost, formatTokens } from "~/lib/usage-format";
import { callToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { IconButton } from "./rail/icon-button";
import { threadToMarkdown } from "./thread-markdown";
import { useThreadUsageSummary } from "./thread-usage";
import { Tip } from "./tip";

/**
 * The chat header's "..." menu.
 *
 * The header had a `Share2` and an `Ellipsis` button from the first commit,
 * both copied from the Dimension design reference and neither wired to
 * anything. This is the ellipsis half. Dimension has no header ellipsis at all
 * — its "..." lives on sidebar rows — so the contents are a decision rather
 * than a port, and the ordering below is the decision:
 *
 *   1. Thread identity — Rename, Pin. What the sidebar row menu already offers,
 *      here aimed at the thread you are reading, so you need not hunt for its
 *      row to rename it.
 *   2. Take it elsewhere — Copy as Markdown.
 *   3. How Alfred behaves — model effort and action autonomy. These MIRROR the
 *      composer's two pickers rather than replacing them: the composer is where
 *      you change them mid-sentence, and this is where you find them when you
 *      have forgotten which control is which. Both write the same state, so the
 *      two surfaces can never disagree.
 *   4. Economics — the thread usage rollup, as a read-only row.
 *   5. Destructive — Delete, last and separated.
 */

const menuSurfaceClass = cn(
  "app z-[200] min-w-[232px] rounded-xl p-1",
  "border border-app-bg-3/70 bg-app-bg-1",
  "shadow-[0_8px_28px_rgba(0,0,0,0.16),0_0_0_1px_rgba(0,0,0,0.04)]",
  "data-[state=open]:animate-[app-fade-in_120ms_ease-out]",
);

const menuItemClass = cn(
  "flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2 text-sm font-medium select-none",
  "text-app-fg-3 outline-none",
  "data-[highlighted]:bg-app-bg-a2 data-[highlighted]:text-app-fg-4",
);

// `relative` anchors the absolutely-positioned `ItemIndicator`; `pl-7` leaves
// room for it so checked and unchecked rows keep the same text baseline.
const radioItemClass = cn(menuItemClass, "relative pl-7 data-[state=checked]:text-app-fg-4");

const sectionLabelClass = "px-2 pt-2 pb-1 text-[11px] font-medium text-app-fg-2 select-none";

export interface ThreadMenuProps {
  /** Absent on a thread that has not been created yet; the menu then stays unmounted. */
  threadId: string | undefined;
  title: string;
  pinned: boolean;
  messages: readonly SyncedChatMessage[];
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
  tier: ChatModelTier;
  onTierChange: (tier: ChatModelTier) => void;
  autoApprove: boolean;
  autoApprovePending: boolean;
  onToggleAutoApprove: () => void;
}

/** Read-only economics row. Renders nothing before a turn has landed with usage. */
function UsageRow({ messages }: { messages: readonly SyncedChatMessage[] }) {
  const summary = useThreadUsageSummary(messages);

  if (summary.turns === 0) return null;

  return (
    <div className="px-2 pt-1.5 pb-2 text-[11px] leading-relaxed text-app-fg-2 tabular-nums">
      <div className="font-medium text-app-fg-4">
        {formatCost(summary.costUsd)} · {summary.turns} {summary.turns === 1 ? "turn" : "turns"}
      </div>
      <div>
        {formatTokens(summary.inputTokens)} in · {formatTokens(summary.outputTokens)} out ·{" "}
        {formatTokens(summary.cachedInputTokens)} cached
      </div>
      <div>Excludes the in-flight turn.</div>
    </div>
  );
}

export function ThreadMenu({
  threadId,
  title,
  pinned,
  messages,
  onRename,
  onTogglePin,
  onDelete,
  tier,
  onTierChange,
  autoApprove,
  autoApprovePending,
  onToggleAutoApprove,
}: ThreadMenuProps) {
  const { resolved } = useAppTheme();
  const [open, setOpen] = useState(false);

  // No thread yet means nothing to rename, copy, or delete. An empty menu that
  // opens is worse than no menu, which is the bug this whole change fixes.
  if (!threadId) return null;

  const copyMarkdown = () => {
    navigator.clipboard.writeText(threadToMarkdown(title, messages)).then(
      () => callToast({ message: "Thread copied as Markdown", variant: "success" }),
      () => callToast({ message: "Could not copy the thread.", variant: "error" }),
    );
  };

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <Tip label="Thread settings">
        <DropdownMenu.Trigger asChild>
          <IconButton label="Thread settings" active={open}>
            <Ellipsis size={14} />
          </IconButton>
        </DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          data-app-theme={resolved}
          className={menuSurfaceClass}
          align="end"
          sideOffset={4}
        >
          <DropdownMenu.Item className={menuItemClass} onSelect={onRename}>
            <Pencil size={14} aria-hidden className="text-app-fg-2" />
            Rename
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItemClass} onSelect={onTogglePin}>
            {pinned ? (
              <PinOff size={14} aria-hidden className="text-app-fg-2" />
            ) : (
              <Pin size={14} aria-hidden className="text-app-fg-2" />
            )}
            {pinned ? "Unpin" : "Pin"}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={menuItemClass}
            disabled={messages.length === 0}
            onSelect={copyMarkdown}
          >
            <ClipboardCopy size={14} aria-hidden className="text-app-fg-2" />
            Copy as Markdown
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="my-1 h-px bg-app-bg-3/70" />

          <DropdownMenu.Label className={sectionLabelClass}>Thinking</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={tier}
            onValueChange={(next) => onTierChange(next === "deep" ? "deep" : "standard")}
          >
            <DropdownMenu.RadioItem className={radioItemClass} value="standard">
              <DropdownMenu.ItemIndicator className="absolute left-2">
                <Zap size={13} aria-hidden />
              </DropdownMenu.ItemIndicator>
              Auto
            </DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem className={radioItemClass} value="deep">
              <DropdownMenu.ItemIndicator className="absolute left-2">
                <Brain size={13} aria-hidden />
              </DropdownMenu.ItemIndicator>
              Deep
            </DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Label className={sectionLabelClass}>Actions</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={autoApprove ? "autonomy" : "gated"}
            onValueChange={(next) => {
              // The policy is a global default that a pending mutation is
              // already rewriting; ignore a re-select of the current value so a
              // double click cannot flip it twice.
              if (autoApprovePending) return;

              if ((next === "autonomy") !== autoApprove) onToggleAutoApprove();
            }}
          >
            <DropdownMenu.RadioItem className={radioItemClass} value="gated">
              <DropdownMenu.ItemIndicator className="absolute left-2">
                <ShieldCheck size={13} aria-hidden />
              </DropdownMenu.ItemIndicator>
              Review before acting
            </DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem className={radioItemClass} value="autonomy">
              <DropdownMenu.ItemIndicator className="absolute left-2">
                <Zap size={13} aria-hidden />
              </DropdownMenu.ItemIndicator>
              Autopilot
            </DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator className="my-1 h-px bg-app-bg-3/70" />

          <UsageRow messages={messages} />

          <DropdownMenu.Separator className="my-1 h-px bg-app-bg-3/70" />

          <DropdownMenu.Item
            className={cn(
              menuItemClass,
              "text-app-red-4 data-highlighted:bg-app-red-1 data-highlighted:text-app-red-4",
            )}
            onSelect={onDelete}
          >
            <Trash2 size={14} aria-hidden />
            Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
