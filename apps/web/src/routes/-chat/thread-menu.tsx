import type { ChatModelTier } from "@alfred/contracts";
import type { SyncedChatMessage } from "@alfred/sync";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Brain, ClipboardCopy, Ellipsis, Pencil, Pin, PinOff, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import { useAppTheme } from "~/components/ui/v2";
import { formatCost, formatTokens } from "~/lib/usage-format";
import { callToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { MODE_OPTIONS } from "./approval-mode-options";
import { TIER_OPTIONS } from "./model-tier-options";
import { IconButton } from "./rail/icon-button";
import { threadToMarkdown } from "./thread-markdown";
import { useThreadUsageSummary } from "./thread-usage";
import { Tip } from "./tip";

/**
 * The chat header's "..." menu, in groups: Rename/Pin, Copy as Markdown,
 * model effort and autonomy, usage, then Delete.
 * Effort and autonomy mirror the composer's pickers and read labels from `TIER_OPTIONS` / `MODE_OPTIONS`.
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

// `relative` anchors the `ItemIndicator`; `pl-7` keeps the text baseline fixed.
const radioItemClass = cn(menuItemClass, "relative pl-7 data-[state=checked]:text-app-fg-4");

const sectionLabelClass = "px-2 pt-2 pb-1 text-[11px] font-medium text-app-fg-2 select-none";

/** Local icons: the picker's per-tier SVG does not read at 13px. */
const TIER_ICON = { standard: Zap, deep: Brain } satisfies Record<
  ChatModelTier,
  typeof Zap | typeof Brain
>;

export interface ThreadMenuProps {
  /** Absent before the thread exists; then the menu does not mount. */
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

/**
 * Read-only usage row. Nothing before a turn has usage.
 * Owns its separator: a wrapper separator around `null` draws two rules.
 */
function UsageRow({ messages }: { messages: readonly SyncedChatMessage[] }) {
  const summary = useThreadUsageSummary(messages);

  if (summary.turns === 0) return null;

  return (
    <>
      <DropdownMenu.Separator className="my-1 h-px bg-app-bg-3/70" />
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
    </>
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

  // No thread yet: no menu, because an empty menu is worse.
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
          // Radix refocuses the trigger in a `setTimeout` after close. That steals focus from the
          // Rename editor, whose blur then commits and closes it. Prevent the refocus.
          onCloseAutoFocus={(event) => event.preventDefault()}
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
            {TIER_OPTIONS.map((option) => {
              const Icon = TIER_ICON[option.value];

              return (
                <DropdownMenu.RadioItem
                  key={option.value}
                  className={radioItemClass}
                  value={option.value}
                >
                  <DropdownMenu.ItemIndicator className="absolute left-2">
                    <Icon size={13} aria-hidden />
                  </DropdownMenu.ItemIndicator>
                  {option.label}
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Label className={sectionLabelClass}>Actions</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={autoApprove ? "autonomy" : "gated"}
            onValueChange={(next) => {
              // Ignore a re-select while pending, so a double click cannot flip it twice.
              if (autoApprovePending) return;

              if ((next === "autonomy") !== autoApprove) onToggleAutoApprove();
            }}
          >
            {MODE_OPTIONS.map((option) => (
              <DropdownMenu.RadioItem
                key={option.label}
                className={radioItemClass}
                value={option.autonomy ? "autonomy" : "gated"}
              >
                <DropdownMenu.ItemIndicator className="absolute left-2">
                  <option.Icon size={13} aria-hidden />
                </DropdownMenu.ItemIndicator>
                {option.label}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>

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
