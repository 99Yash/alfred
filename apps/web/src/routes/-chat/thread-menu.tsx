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
 *      have forgotten which control is which. Both write the same state AND
 *      read their labels from the pickers' own `TIER_OPTIONS` / `MODE_OPTIONS`,
 *      so the two surfaces cannot disagree about either.
 *   4. Economics — the thread usage rollup, DEV-ONLY, as a read-only row.
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

/**
 * Indicator glyph per tier. The labels come from `TIER_OPTIONS`; only the icon
 * is local, because the composer's picker draws a per-tier SVG mark that does
 * not read at a 13px menu indicator.
 */
const TIER_ICON = { standard: Zap, deep: Brain } satisfies Record<
  ChatModelTier,
  typeof Zap | typeof Brain
>;

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

/**
 * Read-only economics row.
 *
 * DEV-ONLY, matching `ThreadUsage` in the header and `UsageLine` under a reply:
 * token counts and dollars are internal instrumentation, not a product surface.
 * Renders nothing before a turn has landed with usage either.
 *
 * It owns its own leading separator rather than being wrapped in one, because a
 * separator outside a component that returns `null` draws two adjacent rules on
 * every thread with no usage yet.
 */
function UsageRow({ messages }: { messages: readonly SyncedChatMessage[] }) {
  const summary = useThreadUsageSummary(messages);

  if (!import.meta.env.DEV || summary.turns === 0) return null;

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
          // Radix returns focus to the trigger in a `setTimeout(…, 0)` after the
          // menu closes. `Rename` opens an inline editor that focuses itself on
          // mount, so that timeout fires SECOND, steals the focus back, and the
          // editor's blur handler commits and closes it in the same frame — the
          // rename affordance never appears. The sidebar's copy escapes this
          // only because its trigger unmounts with the row; this trigger does
          // not. Preventing the auto-focus leaves the editor holding focus.
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
              // The policy is a global default that a pending mutation is
              // already rewriting; ignore a re-select of the current value so a
              // double click cannot flip it twice.
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
