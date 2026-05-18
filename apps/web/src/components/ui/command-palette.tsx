/**
 * Dimension-grammar CommandPalette.
 *
 * cmdk + Radix Dialog. Slots:
 *   <CommandPalette open onOpenChange placeholder>
 *     <CommandPalette.Group heading="Navigate">
 *       <CommandPalette.Item value="goto:integrations" onSelect={…} icon={Plug} shortcut="↵">
 *         Integrations
 *       </CommandPalette.Item>
 *       …
 *     </CommandPalette.Group>
 *   </CommandPalette>
 *
 * Items receive an `icon` component + an optional `shortcut` chip. `value` is
 * used by cmdk for filtering; spell it out so search matches are robust.
 *
 * Per recon §3.8: rows are `h-11 rounded-md px-3 text-sm font-medium` with a
 * leading icon tile and a trailing kbd hint. Active row is the highlighted
 * cmdk-selected row.
 */

import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
} from "react";
import {
  Dialog,
  DialogContent,
} from "~/components/ui/dialog";
import { Kbd } from "~/components/ui/kbd";
import { cn } from "~/lib/utils";

type IconComponent = ComponentType<{ size?: number; className?: string }>;

/* -------------------------------------------------------------------------- */
/* Root                                                                        */
/* -------------------------------------------------------------------------- */

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Placeholder for the search input. */
  placeholder?: string;
  /** Optional aria-label fallback when no title is shown. */
  ariaTitle?: string;
  /** Empty-state copy when the query matches nothing. */
  emptyLabel?: string;
  /** Footer slot — usually `<CommandPaletteLegend />`. */
  footer?: ReactNode;
  children?: ReactNode;
}

function Root({
  open,
  onOpenChange,
  placeholder = "Type a command or search…",
  ariaTitle = "Command palette",
  emptyLabel = "No results.",
  footer,
  children,
}: CommandPaletteProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={ariaTitle}
        srOnlyHeader
        className="max-w-[640px] p-0"
      >
        <CommandPrimitive
          label={ariaTitle}
          /* cmdk does its own keyboard handling; Radix's focus trap keeps
           * Tab inside the dialog. */
          className="flex flex-col"
        >
          {/* Header — search input */}
          <div className="flex items-center gap-2.5 border-b border-white/8 px-4">
            <Search size={16} className="shrink-0 text-gray-800" aria-hidden />
            <CommandPrimitive.Input
              placeholder={placeholder}
              className={cn(
                "flex-1 py-[18px] text-sm bg-transparent",
                "border-none outline-none focus:outline-none focus:ring-0",
                "text-gray-1000 placeholder:text-gray-700",
              )}
            />
          </div>

          {/* Body — scrolling list */}
          <CommandPrimitive.List
            className={cn(
              "max-h-[400px] overflow-y-auto scrollbar",
              "p-2",
            )}
          >
            <CommandPrimitive.Empty className="py-8 text-center text-[13px] text-gray-800">
              {emptyLabel}
            </CommandPrimitive.Empty>
            {children}
          </CommandPrimitive.List>

          {footer ? (
            <div className="border-t border-white/8 px-4 py-2.5">
              {footer}
            </div>
          ) : null}
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Group                                                                       */
/* -------------------------------------------------------------------------- */

interface GroupProps {
  heading?: ReactNode;
  children: ReactNode;
}

function Group({ heading, children }: GroupProps) {
  return (
    <CommandPrimitive.Group
      heading={heading}
      className={cn(
        "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1.5",
        "[&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold",
        "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider",
        "[&_[cmdk-group-heading]]:text-gray-700",
        "[&:not(:first-child)]:mt-1",
      )}
    >
      {children}
    </CommandPrimitive.Group>
  );
}

/* -------------------------------------------------------------------------- */
/* Item                                                                        */
/* -------------------------------------------------------------------------- */

interface ItemProps {
  /** Internal id used by cmdk for filtering + onSelect dispatch. */
  value: string;
  /** Searchable keywords beyond the visible label. */
  keywords?: ReadonlyArray<string>;
  /** Triggered on click or Enter while highlighted. */
  onSelect: () => void;
  /** Leading icon component (Lucide). */
  icon?: IconComponent;
  /** Inline keyboard hint shown on the right — usually `↵` for the focused row. */
  shortcut?: string;
  /** Disabled rows still render but cmdk skips them in keyboard nav. */
  disabled?: boolean;
  children: ReactNode;
}

function Item({
  value,
  keywords,
  onSelect,
  icon: Icon,
  shortcut,
  disabled,
  children,
}: ItemProps) {
  return (
    <CommandPrimitive.Item
      value={value}
      keywords={keywords ? [...keywords] : undefined}
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        "group flex items-center gap-2.5 h-11 rounded-md px-2.5",
        "text-sm font-medium text-gray-900",
        "cursor-pointer select-none",
        "data-[selected=true]:bg-[rgb(var(--gray-50))] data-[selected=true]:text-gray-1000",
        "data-[disabled=true]:opacity-40 data-[disabled=true]:cursor-not-allowed",
        "transition-colors duration-150",
      )}
    >
      {Icon ? (
        <span
          className={cn(
            "inline-flex size-7 shrink-0 items-center justify-center rounded-md",
            "frost-icon-tile text-gray-900",
            "group-data-[selected=true]:text-gray-1000",
          )}
        >
          <Icon size={14} />
        </span>
      ) : null}
      <span className="flex-1 truncate">{children}</span>
      {shortcut ? (
        <span className="opacity-0 transition-opacity group-data-[selected=true]:opacity-100">
          <Kbd>{shortcut}</Kbd>
        </span>
      ) : null}
    </CommandPrimitive.Item>
  );
}

/* -------------------------------------------------------------------------- */
/* Legend (footer keyboard hints)                                              */
/* -------------------------------------------------------------------------- */

function Legend({
  hints,
}: {
  hints?: ReadonlyArray<{ keys: ReactNode; label: string }>;
}) {
  const items = hints ?? [
    { keys: "↑↓", label: "Navigate" },
    { keys: "↵", label: "Select" },
    { keys: "Esc", label: "Close" },
  ];
  return (
    <div className="flex items-center justify-end gap-4 text-[11px] text-gray-700 tabular">
      {items.map((h, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          <Kbd>{h.keys}</Kbd>
          <span>{h.label}</span>
        </span>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export const CommandPalette = Object.assign(Root, {
  Group,
  Item,
  Legend,
});
