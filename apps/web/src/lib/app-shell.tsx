import {
  Link,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import {
  Bell,
  Brain,
  ChevronsLeft,
  ChevronsRight,
  Command,
  FileText,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  X,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { authClient } from "~/lib/auth-client";
import { useTheme, type Theme } from "~/lib/theme";
import { cn } from "~/lib/utils";

type IconComponent = ComponentType<{ size?: number; className?: string }>;

interface NavItem {
  to: string;
  label: string;
  icon: IconComponent;
  /** Optional shortcut hint to render on the right side. */
  shortcut?: string;
}

const SECTION_NAV: ReadonlyArray<NavItem> = [
  { to: "/skills", label: "Skills", icon: Plus },
  { to: "/memory", label: "Memory", icon: Brain },
  { to: "/notes", label: "Notes", icon: FileText },
];

/* -----------------------------------------------------------------------------
 * Right-rail slot
 * Pages call useRightRail(node) to mount widget content in the AppShell's right
 * column. Multiple pages can register; the last-registered wins. The shell
 * only renders the right column when something is registered.
 * -------------------------------------------------------------------------- */

interface RightRailContextValue {
  setContent: (node: ReactNode | null) => void;
}

const RightRailContext = createContext<RightRailContextValue | null>(null);

export function useRightRail(node: ReactNode | null) {
  const ctx = useContext(RightRailContext);
  useEffect(() => {
    if (!ctx) return;
    ctx.setContent(node);
    return () => ctx.setContent(null);
  }, [ctx, node]);
}

/* -------------------------------------------------------------------------- */

export function AppShell({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const location = useLocation();
  const [rightRailNode, setRightRailNode] = useState<ReactNode | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Close the mobile drawer on route change.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  // Close the mobile drawer on Escape.
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileNavOpen]);

  const ctx = useMemo<RightRailContextValue>(
    () => ({ setContent: setRightRailNode }),
    [],
  );

  // Unauthenticated routes (login, etc.) get bare children — no chrome.
  if (isPending || !session?.user || location.pathname === "/login") {
    return (
      <RightRailContext.Provider value={ctx}>{children}</RightRailContext.Provider>
    );
  }

  return (
    <RightRailContext.Provider value={ctx}>
      <div className="flex min-h-[100dvh]">
        {/* Mobile hamburger — only visible <md. Sits over content with safe-area padding. */}
        <button
          type="button"
          onClick={() => setMobileNavOpen(true)}
          className={cn(
            "md:hidden fixed top-3 left-3 z-30 inline-flex items-center justify-center",
            "size-9 rounded-md border bg-background/80 backdrop-blur",
            "text-muted-foreground hover:text-foreground",
          )}
          aria-label="Open navigation"
        >
          <Menu size={18} />
        </button>

        {/* Mobile drawer + scrim */}
        {mobileNavOpen ? (
          <div className="md:hidden fixed inset-0 z-40">
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setMobileNavOpen(false)}
              className="absolute inset-0 bg-background/60 backdrop-blur-sm"
            />
            <div className="relative h-full w-[18rem] max-w-[85%] bg-card border-r shadow-pop drawer-slide-in">
              <Sidebar
                email={session.user.email}
                collapsed={false}
                onToggleCollapsed={() => undefined}
                onClose={() => setMobileNavOpen(false)}
                showCloseButton
              />
            </div>
          </div>
        ) : null}

        {/* Desktop sidebar */}
        <aside
          className={cn(
            "hidden md:flex shrink-0 flex-col border-r bg-card/40",
            "transition-[width] duration-200 ease-out",
            collapsed ? "w-[64px]" : "w-[224px]",
          )}
        >
          <Sidebar
            email={session.user.email}
            collapsed={collapsed}
            onToggleCollapsed={() => setCollapsed((c) => !c)}
          />
        </aside>

        {/* Main column + optional right rail */}
        <main className="flex flex-1 min-w-0">
          <div className="flex-1 min-w-0 overflow-x-hidden">{children}</div>

          {rightRailNode ? (
            <aside
              className={cn(
                "hidden lg:flex shrink-0 border-l bg-card/30",
                "w-[320px] xl:w-[360px] flex-col",
              )}
            >
              {rightRailNode}
            </aside>
          ) : null}
        </main>
      </div>
    </RightRailContext.Provider>
  );
}

/* -------------------------------------------------------------------------- */

interface SidebarProps {
  email?: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onClose?: () => void;
  showCloseButton?: boolean;
}

function Sidebar({
  email,
  collapsed,
  onToggleCollapsed,
  onClose,
  showCloseButton,
}: SidebarProps) {
  const { theme, resolved, setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const initial = email?.[0]?.toUpperCase() ?? "·";

  const signOut = async () => {
    await authClient.signOut();
    await navigate({ to: "/login" });
  };

  const cycleTheme = useCallback(() => {
    const order: Theme[] = ["system", "light", "dark"];
    const idx = order.indexOf(theme);
    const next = order[(idx + 1) % order.length] ?? "system";
    setTheme(next);
  }, [theme, setTheme]);

  return (
    <div className="flex h-full flex-col">
      {/* Brand / account row */}
      <div className="flex items-center gap-2 px-3 py-3">
        <div
          className={cn(
            "size-7 shrink-0 rounded-full bg-foreground text-background",
            "grid place-items-center text-[11px] font-semibold",
          )}
          aria-hidden
        >
          {initial}
        </div>
        {!collapsed ? (
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium leading-tight truncate">
              Alfred
            </p>
            <p className="text-[11px] text-muted-foreground truncate">{email}</p>
          </div>
        ) : null}
        {showCloseButton ? (
          <IconButton
            label="Close navigation"
            onClick={onClose}
            icon={<X size={16} />}
          />
        ) : (
          <IconButton
            label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={onToggleCollapsed}
            icon={collapsed ? <ChevronsRight size={14} /> : <ChevronsLeft size={14} />}
          />
        )}
      </div>

      {/* New chat primary CTA */}
      <div className={cn("px-2 pb-2", collapsed && "px-2")}>
        <Link
          to="/"
          className={cn(
            "group flex items-center gap-2 rounded-md border bg-background",
            "px-2.5 py-2 text-[13px] font-medium",
            "hover:bg-accent/60 transition-colors",
            "shadow-soft",
            collapsed && "justify-center px-0",
          )}
        >
          <Plus size={15} className="shrink-0" />
          {!collapsed ? (
            <>
              <span className="flex-1 text-left">New chat</span>
              <kbd className="hidden sm:inline-flex items-center gap-0.5 text-[10px] text-muted-foreground tabular">
                <Command size={10} /> N
              </kbd>
            </>
          ) : null}
        </Link>
      </div>

      {/* Search row */}
      <div className="px-2 pb-3">
        <button
          type="button"
          // Wired later — for now click navigates to home.
          className={cn(
            "group flex w-full items-center gap-2 rounded-md",
            "px-2.5 py-1.5 text-[13px] text-muted-foreground",
            "hover:bg-accent/60 hover:text-foreground transition-colors",
            collapsed && "justify-center px-0",
          )}
        >
          <Search size={15} className="shrink-0" />
          {!collapsed ? (
            <>
              <span className="flex-1 text-left">Search</span>
              <kbd className="hidden sm:inline-flex items-center gap-0.5 text-[10px] tabular">
                <Command size={10} /> K
              </kbd>
            </>
          ) : null}
        </button>
      </div>

      {/* Section nav */}
      <nav className="flex-1 overflow-y-auto scrollbar px-2 space-y-0.5">
        {!collapsed ? (
          <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Workspace
          </p>
        ) : null}
        {SECTION_NAV.map((item) => (
          <NavLink
            key={item.to}
            item={item}
            collapsed={collapsed}
            active={isActive(location.pathname, item.to)}
          />
        ))}

        {!collapsed ? (
          <p className="px-2 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Coming soon
          </p>
        ) : null}
        {[
          { label: "Workflows", icon: Bell },
          { label: "Integrations", icon: Settings },
          { label: "Library", icon: FileText },
        ].map((item) => (
          <div
            key={item.label}
            className={cn(
              "flex items-center gap-2 mx-0 px-2.5 py-1.5 rounded-md text-[13px]",
              "text-muted-foreground/60 cursor-not-allowed",
              collapsed && "justify-center px-0",
            )}
            title={collapsed ? item.label : undefined}
          >
            <item.icon size={15} className="shrink-0" />
            {!collapsed ? <span className="flex-1 truncate">{item.label}</span> : null}
            {!collapsed ? (
              <span className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded border border-dashed border-border/60">
                soon
              </span>
            ) : null}
          </div>
        ))}
      </nav>

      {/* Footer: theme + sign-out */}
      <div className="border-t px-2 py-2 space-y-0.5">
        <button
          type="button"
          onClick={cycleTheme}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px]",
            "text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors",
            collapsed && "justify-center px-0",
          )}
          title={collapsed ? `Theme: ${theme}` : undefined}
        >
          <ThemeIcon theme={theme} resolved={resolved} />
          {!collapsed ? (
            <>
              <span className="flex-1 text-left capitalize">{theme}</span>
              <span className="text-[10px] text-muted-foreground/70 capitalize">
                {resolved}
              </span>
            </>
          ) : null}
        </button>

        <button
          type="button"
          onClick={signOut}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px]",
            "text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors",
            collapsed && "justify-center px-0",
          )}
          title={collapsed ? "Sign out" : undefined}
        >
          <LogOut size={15} className="shrink-0" />
          {!collapsed ? <span>Sign out</span> : null}
        </button>
      </div>
    </div>
  );
}

function NavLink({
  item,
  collapsed,
  active,
}: {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      className={cn(
        "group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px]",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-accent/60",
        "transition-colors",
        collapsed && "justify-center px-0",
      )}
      title={collapsed ? item.label : undefined}
    >
      <Icon size={15} className="shrink-0" />
      {!collapsed ? (
        <>
          <span className="flex-1 truncate">{item.label}</span>
          {item.shortcut ? (
            <kbd className="hidden xl:inline-flex text-[10px] text-muted-foreground/70 tabular">
              {item.shortcut}
            </kbd>
          ) : null}
        </>
      ) : null}
    </Link>
  );
}

function IconButton({
  label,
  onClick,
  icon,
}: {
  label: string;
  onClick?: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "inline-flex items-center justify-center size-6 rounded-md",
        "text-muted-foreground hover:text-foreground hover:bg-accent/60",
        "transition-colors",
      )}
    >
      {icon}
    </button>
  );
}

function ThemeIcon({
  theme,
  resolved,
}: {
  theme: Theme;
  resolved: "light" | "dark";
}) {
  if (theme === "system") return <Monitor size={15} className="shrink-0" />;
  return resolved === "dark" ? (
    <Moon size={15} className="shrink-0" />
  ) : (
    <Sun size={15} className="shrink-0" />
  );
}

function isActive(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

