import * as RadixDialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  Brain,
  ChevronsLeft,
  ChevronsRight,
  Command,
  FileText,
  LogOut,
  Menu,
  Monitor,
  Moon,
  MoonStar,
  Plus,
  Plug,
  Search,
  Settings,
  Sparkles,
  Sun,
  Workflow,
  X,
} from "lucide-react";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { CommandPalette } from "~/components/ui/command-palette";
import { authClient } from "~/lib/auth-client";
import { client } from "~/lib/eden";
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
  { to: "/integrations", label: "Integrations", icon: Plug },
  { to: "/workflows", label: "Workflows", icon: Workflow },
  { to: "/skills", label: "Skills", icon: Sparkles },
  { to: "/library", label: "Library", icon: Archive },
];

const PERSONAL_NAV: ReadonlyArray<NavItem> = [
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
  const ctx = use(RightRailContext);
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
  const navigate = useNavigate();
  const [rightRailNode, setRightRailNode] = useState<ReactNode | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  /* Server-truth onboarding flag (ADR-style: don't trust the client). Only
   * fetched once we know we're authed; the `enabled` keeps the query off
   * the login screen. */
  const sessionUser = session?.user;
  const onboardingQuery = useQuery({
    queryKey: ["me", "onboarding"],
    queryFn: async () => {
      const res = await client.api.me.onboarding.get();
      if (res.error) throw new Error("Failed to load onboarding state");
      return res.data;
    },
    enabled: !isPending && !!sessionUser,
    staleTime: 60_000,
  });

  /* Gate `/onboarding` access in both directions:
   *   - new user (routeToOnboarding=true) on any other authed route → /onboarding
   *   - finished user on /onboarding → /
   * `pendingNavigation` is computed during render (no derived-state effect). */
  const routeToOnboarding = onboardingQuery.data?.routeToOnboarding;
  const onOnboardingRoute = location.pathname.startsWith("/onboarding");
  const onPreviewRoute = location.pathname.startsWith("/preview/");
  useEffect(() => {
    if (!sessionUser) return;
    if (routeToOnboarding === undefined) return;
    // `/preview/*` is a design playground — never gate it.
    if (onPreviewRoute) return;
    if (routeToOnboarding && !onOnboardingRoute) {
      void navigate({ to: "/onboarding", search: { step: 1 } });
    } else if (!routeToOnboarding && onOnboardingRoute) {
      void navigate({ to: "/" });
    }
  }, [routeToOnboarding, onOnboardingRoute, onPreviewRoute, sessionUser, navigate]);

  // Close the mobile drawer + palette on route change. Tracking the previous
  // location in a ref (not state — we never read it in render) and resetting
  // during render replaces the prior useEffects that the linter flagged as
  // derived-state effects.
  const prevLocationRef = useRef(location);
  if (prevLocationRef.current !== location) {
    prevLocationRef.current = location;
    setMobileNavOpen(false);
    setPaletteOpen(false);
  }

  /* Routes that render edge-to-edge (no sidebar, no rail). */
  const chromeless =
    location.pathname === "/login" ||
    location.pathname.startsWith("/onboarding") ||
    location.pathname.startsWith("/preview/");

  // Global ⌘K / Ctrl+K toggles the command palette while authenticated.
  const authed = !isPending && !!session?.user && !chromeless;
  useEffect(() => {
    if (!authed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [authed]);

  const ctx = useMemo<RightRailContextValue>(() => ({ setContent: setRightRailNode }), []);

  // Unauthenticated routes (login, etc.) get bare children — no chrome.
  if (!authed) {
    return <RightRailContext.Provider value={ctx}>{children}</RightRailContext.Provider>;
  }

  // First-load gating: between "session resolved" and "onboarding query
  // resolved" we don't yet know whether to redirect new users to
  // /onboarding. Without this guard, the route's component (e.g. HomePage)
  // paints for a frame before the effect above navigates away. Render the
  // chrome but blank the main column until we know.
  const gatingPending = routeToOnboarding === undefined && !onPreviewRoute && !onOnboardingRoute;
  const mainContent = gatingPending ? null : children;

  return (
    <RightRailContext.Provider value={ctx}>
      <div className="flex min-h-[100dvh]">
        {/* Mobile drawer — Radix Dialog gives us focus trap, scroll lock,
         * Escape, and outside-click for free. Hamburger trigger lives inside
         * the root so the open state stays centralized. */}
        <RadixDialog.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <RadixDialog.Trigger asChild>
            <button
              type="button"
              className={cn(
                "md:hidden fixed top-3 left-3 z-30 inline-flex items-center justify-center",
                "size-9 rounded-md border bg-background/80 backdrop-blur",
                "text-muted-foreground hover:text-foreground",
              )}
              aria-label="Open navigation"
            >
              <Menu size={18} />
            </button>
          </RadixDialog.Trigger>
          <RadixDialog.Portal>
            <RadixDialog.Overlay
              className={cn(
                "md:hidden fixed inset-0 z-40 bg-background/60 backdrop-blur-sm",
                "data-[state=open]:animate-[dialog-overlay-in_180ms_cubic-bezier(0.2,0,0,1)]",
                "data-[state=closed]:animate-[dialog-overlay-out_140ms_cubic-bezier(0.2,0,0,1)]",
              )}
            />
            <RadixDialog.Content
              aria-describedby={undefined}
              className={cn(
                "md:hidden fixed inset-y-0 left-0 z-50",
                "h-full w-[18rem] max-w-[85%]",
                "bg-card border-r shadow-pop focus:outline-none",
                "data-[state=open]:drawer-slide-in",
              )}
            >
              <RadixDialog.Title className="sr-only">Navigation</RadixDialog.Title>
              <Sidebar
                email={session.user.email}
                collapsed={false}
                onToggleCollapsed={() => undefined}
                onClose={() => setMobileNavOpen(false)}
                showCloseButton
                onOpenPalette={() => setPaletteOpen(true)}
              />
            </RadixDialog.Content>
          </RadixDialog.Portal>
        </RadixDialog.Root>

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
            onOpenPalette={() => setPaletteOpen(true)}
          />
        </aside>

        {/* Main column + optional right rail */}
        <main className="flex flex-1 min-w-0">
          <div className="flex-1 min-w-0 overflow-x-hidden">{mainContent}</div>

          {rightRailNode ? (
            <aside
              className={cn(
                "hidden lg:flex shrink-0 flex-col bg-background p-2 pl-0",
                "w-[344px] xl:w-[374px]",
              )}
            >
              {rightRailNode}
            </aside>
          ) : null}
        </main>

        <AppCommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
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
  onOpenPalette?: () => void;
}

function Sidebar({
  email,
  collapsed,
  onToggleCollapsed,
  onClose,
  showCloseButton,
  onOpenPalette,
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
      <div className="flex items-center gap-2 p-3">
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
            <p className="text-[13px] font-medium leading-tight truncate">Alfred</p>
            <p className="text-[11px] text-muted-foreground truncate">{email}</p>
          </div>
        ) : null}
        {showCloseButton ? (
          <IconButton label="Close navigation" onClick={onClose} icon={<X size={16} />} />
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
          onClick={onOpenPalette}
          aria-label="Open search"
          className={cn(
            "group flex w-full items-center gap-2 rounded-md",
            "px-2.5 py-1.5 text-[13px] text-muted-foreground",
            "hover:bg-accent/60 hover:text-foreground transition-colors",
            collapsed && "justify-center px-0",
          )}
          title={collapsed ? "Search (⌘K)" : undefined}
        >
          <Search size={15} className="shrink-0" />
          {!collapsed ? (
            <>
              <span className="flex-1 text-left">Search</span>
              <kbd className="hidden sm:inline-flex items-center gap-0.5 text-[10px] text-muted-foreground tabular">
                <Command size={10} /> K
              </kbd>
            </>
          ) : null}
        </button>
      </div>

      {/* Section nav */}
      <nav className="flex-1 overflow-y-auto scrollbar px-2 space-y-0.5">
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
            Personal
          </p>
        ) : null}
        {PERSONAL_NAV.map((item) => (
          <NavLink
            key={item.to}
            item={item}
            collapsed={collapsed}
            active={isActive(location.pathname, item.to)}
          />
        ))}
      </nav>

      {/* Footer: settings + theme + sign-out */}
      <div className="border-t p-2 space-y-0.5">
        <NavLink
          item={{ to: "/settings", label: "Settings", icon: Settings }}
          collapsed={collapsed}
          active={isActive(location.pathname, "/settings")}
        />
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
              <span className="text-[10px] text-muted-foreground/70 capitalize">{resolved}</span>
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

function ThemeIcon({ theme, resolved }: { theme: Theme; resolved: "light" | "dark" }) {
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

/* -----------------------------------------------------------------------------
 * App-level command palette
 * Mounted at AppShell scope so ⌘K works on every authed route. Routes can layer
 * their own commands later by reading a context — for now this set covers
 * navigation, theme cycling, and sign-out.
 * -------------------------------------------------------------------------- */

function AppCommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();

  const go = useCallback(
    (to: string) => {
      onOpenChange(false);
      void navigate({ to });
    },
    [navigate, onOpenChange],
  );

  const cycleTheme = useCallback(() => {
    const order: Theme[] = ["system", "light", "dark"];
    const idx = order.indexOf(theme);
    const next = order[(idx + 1) % order.length] ?? "system";
    setTheme(next);
    onOpenChange(false);
  }, [theme, setTheme, onOpenChange]);

  const signOut = useCallback(async () => {
    onOpenChange(false);
    await authClient.signOut();
    await navigate({ to: "/login" });
  }, [navigate, onOpenChange]);

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      placeholder="Search for chats, skills, integrations…"
      ariaTitle="Search Alfred"
      footer={<CommandPalette.Legend />}
    >
      <CommandPalette.Group heading="Actions">
        <CommandPalette.Item
          value="action:new-chat"
          keywords={["new", "chat", "thread", "compose"]}
          onSelect={() => go("/")}
          icon={Plus}
          shortcut="↵"
        >
          New chat
        </CommandPalette.Item>
        <CommandPalette.Item
          value="action:cycle-theme"
          keywords={["theme", "dark", "light", "system", "appearance"]}
          onSelect={cycleTheme}
          icon={MoonStar}
        >
          Cycle theme
        </CommandPalette.Item>
        <CommandPalette.Item
          value="action:sign-out"
          keywords={["logout", "sign out", "log out"]}
          onSelect={signOut}
          icon={LogOut}
        >
          Sign out
        </CommandPalette.Item>
      </CommandPalette.Group>

      <CommandPalette.Group heading="Navigate">
        {[...SECTION_NAV, ...PERSONAL_NAV].map((item) => (
          <CommandPalette.Item
            key={item.to}
            value={`nav:${item.to}`}
            keywords={[item.label.toLowerCase()]}
            onSelect={() => go(item.to)}
            icon={item.icon}
          >
            {item.label}
          </CommandPalette.Item>
        ))}
        <CommandPalette.Item
          value="nav:/settings"
          keywords={["settings", "preferences", "account"]}
          onSelect={() => go("/settings")}
          icon={Settings}
        >
          Settings
        </CommandPalette.Item>
      </CommandPalette.Group>
    </CommandPalette>
  );
}
