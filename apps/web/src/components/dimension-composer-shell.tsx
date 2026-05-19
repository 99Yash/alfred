import { ArrowUp, Sparkles } from "lucide-react";
import { type FormEventHandler, type ReactNode } from "react";
import { cn } from "~/lib/utils";

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

export function DimensionComposerIconButton({
  label,
  disabled,
  children,
  onClick,
  className,
}: {
  label: string;
  disabled?: boolean;
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-8 place-items-center rounded-full text-white/78",
        "transition-colors hover:bg-white/[0.055] hover:text-white",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-600/35",
        "disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
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
