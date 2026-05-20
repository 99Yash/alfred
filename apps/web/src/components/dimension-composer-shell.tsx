import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { ArrowUp, Check, ChevronDown, Ellipsis, Sparkles } from "lucide-react";
import type {
  ButtonHTMLAttributes,
  FormEventHandler,
  ReactNode,
  Ref,
} from "react";
import { cn } from "~/lib/utils";

export type DimensionComposerMenuItem = {
  label: string;
  description?: string;
  icon?: ReactNode;
  onSelect?: () => void;
  href?: string;
  disabled?: boolean;
};

export type DimensionModelOption = {
  id: string;
  label: string;
  description: string;
  selected?: boolean;
};

export function DimensionComposerShell({
  children,
  toolbar,
  tray,
  onSubmit,
  className,
  "aria-label": ariaLabel = "Message composer",
}: {
  children: ReactNode;
  toolbar: ReactNode;
  tray?: ReactNode;
  onSubmit: FormEventHandler<HTMLFormElement>;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <form
      aria-label={ariaLabel}
      onSubmit={onSubmit}
      className={cn(
        "relative overflow-visible rounded-2xl bg-[#080808]/95 p-1 shadow-pop",
        "ring-1 ring-white/10 backdrop-blur-xl",
        "focus-within:ring-2 focus-within:ring-ring/45",
        "transition-[box-shadow,background-color]",
        tray ? "pb-0" : undefined,
        className,
      )}
    >
      {children}
      {toolbar}
      {tray}
    </form>
  );
}

export function DimensionComposerToolbar({
  start,
  end,
  className,
  startClassName,
  endClassName,
}: {
  start: ReactNode;
  end: ReactNode;
  className?: string;
  startClassName?: string;
  endClassName?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-2 px-1 pb-1", className)}>
      <div className={cn("flex min-w-0 items-center gap-1", startClassName)}>{start}</div>
      <div className={cn("flex items-center gap-1", endClassName)}>{end}</div>
    </div>
  );
}

type DimensionComposerIconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  label: string;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
};

export function DimensionComposerIconButton({
  label,
  disabled,
  children,
  className,
  ref,
  ...props
}: DimensionComposerIconButtonProps) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      disabled={disabled}
      className={cn(
        "grid size-8 place-items-center rounded-full text-white/78",
        "transition-colors hover:bg-white/[0.055] hover:text-white",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-600/35",
        "disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function DimensionComposerSendButton({ disabled }: { disabled?: boolean }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      aria-label="Send"
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full",
        "transition-[opacity,filter,transform] active:scale-[0.96]",
        "text-black backdrop-blur-sm",
        "bg-[linear-gradient(180deg,#a5a5a5_46%,#e3e3e3_100%)]",
        "shadow-[0_0_0_0.5px_rgba(0,0,0,0.4),0_18px_11px_rgba(0,0,0,0.01),0_8px_8px_rgba(0,0,0,0.01),0_2px_4px_rgba(0,0,0,0.02)]",
        disabled ? "cursor-not-allowed opacity-50" : "hover:brightness-110 active:brightness-105",
      )}
    >
      <ArrowUp size={16} strokeWidth={2.25} />
    </button>
  );
}

/**
 * Semantic model chip. Labels stay Alfred-specific; the geometry and material
 * mirror Dimension's compact model selector.
 */
export function DimensionModelChip({
  value,
  disabled = true,
}: {
  value: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title="Model picker"
      className={cn(
        "inline-flex h-[30px] w-[108px] items-center justify-between gap-2 rounded-lg px-2 py-1",
        "border border-transparent bg-[linear-gradient(180deg,#0C0C0C_0%,#151515_100%)]",
        "text-[13px] font-normal text-white/86 backdrop-blur-sm",
        "shadow-[inset_0_0_4px_rgba(0,0,0,0.4)]",
        "transition-[filter] hover:brightness-110",
        disabled ? "cursor-not-allowed opacity-95" : undefined,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full",
          "bg-[radial-gradient(circle_at_30%_30%,#a5a5a5,#1e1e1e_70%)]",
          "shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(0,0,0,0.4)]",
        )}
      >
        <Sparkles size={9} className="text-white/85" />
      </span>
      <span className="leading-none">{value}</span>
    </button>
  );
}

export function DimensionComposerContextMenu({
  label = "Add context",
  items,
  children,
}: {
  label?: string;
  items: DimensionComposerMenuItem[];
  children: ReactNode;
}) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <DimensionComposerIconButton label={label}>{children}</DimensionComposerIconButton>
      </DropdownMenuPrimitive.Trigger>
      <DimensionDropdownContent align="start">
        <div className="px-2 pb-1 pt-1.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-white/35">
            Add context
          </p>
        </div>
        {items.map((item) => (
          <DimensionDropdownItem key={item.label} item={item} />
        ))}
      </DimensionDropdownContent>
    </DropdownMenuPrimitive.Root>
  );
}

export function DimensionComposerOverflowMenu({ items }: { items: DimensionComposerMenuItem[] }) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <DimensionComposerIconButton label="Composer options">
          <Ellipsis size={15} />
        </DimensionComposerIconButton>
      </DropdownMenuPrimitive.Trigger>
      <DimensionDropdownContent align="end">
        {items.map((item) => (
          <DimensionDropdownItem key={item.label} item={item} />
        ))}
      </DimensionDropdownContent>
    </DropdownMenuPrimitive.Root>
  );
}

export function DimensionModelPicker({
  value,
  options,
  onSelect,
}: {
  value: string;
  options: DimensionModelOption[];
  onSelect?: (id: string) => void;
}) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          title="Model picker"
          className={cn(
            "inline-flex h-[30px] w-[108px] items-center justify-between gap-2 rounded-lg px-2 py-1",
            "border border-transparent bg-[linear-gradient(180deg,#0C0C0C_0%,#151515_100%)]",
            "text-[13px] font-normal text-white/86 backdrop-blur-sm",
            "shadow-[inset_0_0_4px_rgba(0,0,0,0.4)]",
            "transition-[filter] hover:brightness-110",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-600/35",
            "data-[state=open]:brightness-110",
          )}
        >
          <ModelOrb />
          <span className="leading-none">{value}</span>
          <ChevronDown size={12} className="text-white/42" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className={cn(
            "z-50 w-[280px] rounded-2xl p-2",
            "frost-popover shadow-pop outline-none",
            "animate-menu-pop-in origin-bottom-right",
            "data-[state=closed]:hidden",
          )}
        >
          <div className="px-2 pb-1 pt-1.5">
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-white/35">
              Model
            </p>
          </div>
          <div className="space-y-0.5">
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => onSelect?.(option.id)}
                className={cn(
                  "flex min-h-12 w-full items-center gap-2 rounded-[10px] px-2.5 py-2 text-left",
                  "outline-none transition-colors hover:bg-white/[0.055]",
                  "focus-visible:bg-white/[0.07]",
                )}
              >
                <ModelOrb />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-white/86">
                    {option.label}
                  </span>
                  <span className="block truncate text-[12px] text-white/42">
                    {option.description}
                  </span>
                </span>
                {option.selected ? <Check size={14} className="shrink-0 text-purple-300" /> : null}
              </button>
            ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function DimensionDropdownContent({
  children,
  align,
}: {
  children: ReactNode;
  align: "start" | "end";
}) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        side="top"
        align={align}
        sideOffset={8}
        collisionPadding={16}
        className={cn(
          "z-50 w-[276px] rounded-2xl p-2",
          "frost-popover shadow-pop outline-none",
          "data-[state=closed]:hidden",
          align === "start" ? "origin-bottom-left" : "origin-bottom-right",
          "animate-menu-pop-in",
        )}
      >
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
}

function DimensionDropdownItem({ item }: { item: DimensionComposerMenuItem }) {
  const className = cn(
    "flex min-h-11 w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left",
    "text-[13px] text-white/82 outline-none transition-colors",
    item.disabled
      ? "cursor-not-allowed opacity-42"
      : "cursor-default hover:bg-white/[0.055] focus:bg-white/[0.07]",
  );
  const content = (
    <>
      {item.icon ? (
        <span className="grid size-7 shrink-0 place-items-center rounded-xl bg-white/[0.045] text-white/58">
          {item.icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{item.label}</span>
        {item.description ? (
          <span className="block truncate text-[12px] text-white/42">{item.description}</span>
        ) : null}
      </span>
    </>
  );

  if (item.href && !item.disabled) {
    return (
      <DropdownMenuPrimitive.Item asChild>
        <a href={item.href} className={className}>
          {content}
        </a>
      </DropdownMenuPrimitive.Item>
    );
  }

  return (
    <DropdownMenuPrimitive.Item
      disabled={item.disabled}
      onSelect={item.onSelect}
      className={className}
    >
      {content}
    </DropdownMenuPrimitive.Item>
  );
}

function ModelOrb() {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-full",
        "bg-[radial-gradient(circle_at_30%_30%,#a5a5a5,#1e1e1e_70%)]",
        "shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(0,0,0,0.4)]",
      )}
    >
      <Sparkles size={9} className="text-white/85" />
    </span>
  );
}
