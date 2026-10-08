/**
 * Command palette: cmdk inside a Radix Dialog.
 * Use `CommandPalette.Group` and `CommandPalette.Item`; cmdk filters on `value`, so spell it out.
 */

import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { type ComponentType, type ReactNode } from "react";
import { Dialog, DialogContent } from "~/components/ui/dialog";
import { Kbd } from "~/components/ui/kbd";
import { cn } from "~/lib/utils";

type IconComponent = ComponentType<{ size?: number; className?: string }>;

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placeholder?: string | undefined;
  /** aria-label used when no title is shown. */
  ariaTitle?: string | undefined;
  emptyLabel?: string | undefined;
  /** Usually `<CommandPaletteLegend />`. */
  footer?: ReactNode | undefined;
  children?: ReactNode | undefined;
}

export function CommandPalette({
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
      <DialogContent title={ariaTitle} srOnlyHeader className="max-w-[640px] p-0">
        <CommandPrimitive
          label={ariaTitle}
          /* cmdk owns the keyboard; Radix's focus trap keeps Tab in the dialog. */
          className="flex flex-col"
        >
          {/* Search input */}
          <div className="flex items-center gap-2.5 border-b border-white/8 px-4">
            <Search size={16} className="shrink-0 text-gray-800" aria-hidden />
            <CommandPrimitive.Input
              placeholder={placeholder}
              className={cn(
                "flex-1 bg-transparent py-[18px] text-sm",
                "border-none outline-none focus:ring-0 focus:outline-none",
                "text-gray-1000 placeholder:text-gray-700",
              )}
            />
          </div>

          {/* Scrolling list */}
          <CommandPrimitive.List className={cn("scrollbar max-h-[400px] overflow-y-auto", "p-2")}>
            <CommandPrimitive.Empty className="py-8 text-center text-[13px] text-gray-800">
              {emptyLabel}
            </CommandPrimitive.Empty>
            {children}
          </CommandPrimitive.List>

          {footer ? <div className="border-t border-white/8 px-4 py-2.5">{footer}</div> : null}
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}

interface GroupProps {
  heading?: ReactNode | undefined;
  children: ReactNode;
}

function Group({ heading, children }: GroupProps) {
  return (
    <CommandPrimitive.Group
      heading={heading}
      className={cn(
        "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1.5",
        "[&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold",
        "[&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:uppercase",
        "[&_[cmdk-group-heading]]:text-gray-700",
        "[&:not(:first-child)]:mt-1",
      )}
    >
      {children}
    </CommandPrimitive.Group>
  );
}

interface ItemProps {
  /** cmdk's id for filtering and `onSelect`. */
  value: string;
  keywords?: ReadonlyArray<string> | undefined;
  onSelect: () => void;
  icon?: IconComponent | undefined;
  /** Right-side keyboard hint, usually `↵`. */
  shortcut?: string | undefined;
  /** Still rendered, but keyboard nav skips it. */
  disabled?: boolean | undefined;
  children: ReactNode;
}

function Item({ value, keywords, onSelect, icon: Icon, shortcut, disabled, children }: ItemProps) {
  return (
    <CommandPrimitive.Item
      value={value}
      {...(keywords ? { keywords: [...keywords] } : {})}
      onSelect={onSelect}
      {...(disabled === undefined ? {} : { disabled })}
      className={cn(
        "group flex h-11 items-center gap-2.5 rounded-md px-2.5",
        "text-sm font-medium text-gray-900",
        "cursor-pointer select-none",
        "data-[selected=true]:bg-[rgb(var(--gray-50))] data-[selected=true]:text-gray-1000",
        "data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-40",
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

/* Footer keyboard hints */

function Legend({ hints }: { hints?: ReadonlyArray<{ keys: ReactNode; label: string }> }) {
  const items = hints ?? [
    { keys: "↑↓", label: "Navigate" },
    { keys: "↵", label: "Select" },
    { keys: "Esc", label: "Close" },
  ];

  return (
    <div className="tabular flex items-center justify-end gap-4 text-[11px] text-gray-700">
      {items.map((h) => (
        <span key={h.label} className="inline-flex items-center gap-1.5">
          <Kbd>{h.keys}</Kbd>
          <span>{h.label}</span>
        </span>
      ))}
    </div>
  );
}

const groupComponent = Group;

const itemComponent = Item;

const legendComponent = Legend;

export namespace CommandPalette {
  export const Group = groupComponent;
  export const Item = itemComponent;
  export const Legend = legendComponent;
}
