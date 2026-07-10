import * as Tooltip from "@radix-ui/react-tooltip";
import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useAppTheme } from "~/components/ui/v2";
import { cn } from "~/lib/utils";
import { railIconClass } from "./navigation-primitives.styles";

interface BaseNavProps {
  icon: LucideIcon;
  label: string;
  kbd?: string;
  badge?: string;
  active?: boolean;
}

export function SidebarHeading({ children }: { children: ReactNode }) {
  return (
    <div className="px-5 pt-3 pb-1 text-[10.5px] font-medium tracking-tight text-app-fg-2 uppercase">
      {children}
    </div>
  );
}

const navRowClass = (active = false) =>
  cn(
    "group inline-flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-left",
    "app-press transition-[background-color,color] duration-150",
    "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
    active
      ? "sidebar-tile text-app-fg-4"
      : "text-app-fg-3 hover:bg-app-bg-a2 hover:text-app-fg-4 hover:shadow-[inset_0_1px_0_var(--app-sidebar-tile-highlight)]",
  );

function NavInner({ icon: Icon, label, kbd, badge, active }: BaseNavProps) {
  return (
    <>
      <Icon
        size={15}
        strokeWidth={1.75}
        aria-hidden
        className={cn(
          "shrink-0 transition-colors",
          active ? "text-app-fg-4" : "text-app-fg-2 group-hover:text-app-fg-4",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      {badge ? (
        <span className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-app-purple-1 px-1 text-[10.5px] font-medium text-app-purple-4 tabular-nums">
          {badge}
        </span>
      ) : null}
      {kbd ? <KbdHint>{kbd}</KbdHint> : null}
    </>
  );
}

export function NavButton({ onClick, ...props }: BaseNavProps & { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={props.active ? "page" : undefined}
      className={navRowClass(props.active)}
    >
      <NavInner {...props} />
    </button>
  );
}

export function NavLink({ to, ...props }: BaseNavProps & { to: string }) {
  return (
    <Link
      to={to}
      aria-current={props.active ? "page" : undefined}
      className={navRowClass(props.active)}
    >
      <NavInner {...props} />
    </Link>
  );
}

function KbdHint({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4.5 min-w-5 items-center justify-center rounded-md bg-app-bg-a2 px-1 font-sans text-[10.5px] leading-none font-medium text-app-fg-3 tabular-nums">
      {children}
    </kbd>
  );
}

export function RailTip({
  label,
  kbd,
  children,
}: {
  label: string;
  kbd?: string;
  children: ReactNode;
}) {
  const { resolved } = useAppTheme();
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="right"
          sideOffset={8}
          data-app-theme={resolved}
          className={cn(
            "app z-[200] inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium",
            "bg-app-fg-4 text-app-bg-1 shadow-[0_2px_8px_rgba(0,0,0,0.18)]",
            "select-none data-[state=delayed-open]:animate-[app-fade-in_120ms_ease-out]",
          )}
        >
          {label}
          {kbd ? <span className="text-app-bg-1/60 tabular-nums">{kbd}</span> : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function RailLink({
  icon: Icon,
  label,
  to,
  active,
  badge,
  kbd,
}: BaseNavProps & { to: string }) {
  return (
    <RailTip label={label} kbd={kbd}>
      <Link
        to={to}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={railIconClass(active)}
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden />
        {badge ? (
          <span className="absolute -top-0.5 -right-0.5 inline-flex h-3.75 min-w-3.75 items-center justify-center rounded-full bg-app-purple-4 px-1 text-[9px] font-semibold text-white tabular-nums">
            {badge}
          </span>
        ) : null}
      </Link>
    </RailTip>
  );
}

export function RailButton({
  icon: Icon,
  label,
  onClick,
}: Pick<BaseNavProps, "icon" | "label"> & { onClick: () => void }) {
  return (
    <RailTip label={label}>
      <button type="button" aria-label={label} onClick={onClick} className={railIconClass(false)}>
        <Icon size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </RailTip>
  );
}
