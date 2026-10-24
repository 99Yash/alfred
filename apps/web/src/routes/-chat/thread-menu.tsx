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
  Trash2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import {
  appMenuDangerItemClass,
  appMenuItemClass,
  appMenuSeparatorClass,
  appMenuSurfaceClass,
  useAppTheme,
} from "~/components/ui/v2";
import { callToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { MODE_OPTIONS, type ChatApprovalMode } from "./approval-mode-options";
import { TIER_OPTIONS } from "./model-tier-options";
import { IconButton } from "./rail/icon-button";
import { threadToMarkdown } from "./thread-markdown";
import { Tip } from "./tip";

/**
 * The chat header's "..." menu, in groups: Rename/Pin, Copy as Markdown,
 * model effort and autonomy, then Delete. Usage lives in the header's `ThreadUsageButton`.
 * Effort and autonomy mirror the composer's pickers and read labels from `TIER_OPTIONS` / `MODE_OPTIONS`.
 */

const menuSurfaceClass = cn(appMenuSurfaceClass, "min-w-[232px]");

// `relative` anchors the `ItemIndicator`; `pl-7` keeps the text baseline fixed.
const radioItemClass = cn(appMenuItemClass, "relative pl-7 data-[state=checked]:text-app-fg-4");

const sectionLabelClass = "px-2 pt-2 pb-1 text-[11px] font-medium text-app-fg-2 select-none";

/** Local icons: the picker's per-tier SVG does not read at 13px. */
const TIER_ICON = { standard: Zap, deep: Brain } satisfies Record<ChatModelTier, LucideIcon>;

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
  approvalMode: ChatApprovalMode;
  approvalModePending: boolean;
  onApprovalModeChange: (mode: ChatApprovalMode) => void;
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
  approvalMode,
  approvalModePending,
  onApprovalModeChange,
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
          <DropdownMenu.Item className={appMenuItemClass} onSelect={onRename}>
            <Pencil size={14} aria-hidden className="text-app-fg-2" />
            Rename
          </DropdownMenu.Item>
          <DropdownMenu.Item className={appMenuItemClass} onSelect={onTogglePin}>
            {pinned ? (
              <PinOff size={14} aria-hidden className="text-app-fg-2" />
            ) : (
              <Pin size={14} aria-hidden className="text-app-fg-2" />
            )}
            {pinned ? "Unpin" : "Pin"}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={appMenuItemClass}
            disabled={messages.length === 0}
            onSelect={copyMarkdown}
          >
            <ClipboardCopy size={14} aria-hidden className="text-app-fg-2" />
            Copy as Markdown
          </DropdownMenu.Item>

          <DropdownMenu.Separator className={appMenuSeparatorClass} />

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
            value={approvalMode}
            onValueChange={(next) => {
              // Ignore a re-select while pending, so a double click cannot flip it twice.
              if (approvalModePending) return;

              const option = MODE_OPTIONS.find((candidate) => candidate.value === next);

              if (option && option.value !== approvalMode) onApprovalModeChange(option.value);
            }}
          >
            {MODE_OPTIONS.map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                className={radioItemClass}
                value={option.value}
              >
                <DropdownMenu.ItemIndicator className="absolute left-2">
                  <option.Icon size={13} aria-hidden />
                </DropdownMenu.ItemIndicator>
                {option.label}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator className={appMenuSeparatorClass} />

          <DropdownMenu.Item className={appMenuDangerItemClass} onSelect={onDelete}>
            <Trash2 size={14} aria-hidden />
            Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
