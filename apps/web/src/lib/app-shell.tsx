import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  createContext,
  lazy,
  Suspense,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChatContext } from "~/components/chat-context";
import { AppThemeProvider } from "~/components/ui/v2/theme";
import { authClient } from "~/lib/auth-client";
import { writeAuthHint } from "~/lib/auth-hint";
import { client } from "~/lib/eden";

/* -----------------------------------------------------------------------------
 * Right-rail slot
 * Pages call useRightRail(node) to mount widget content as a flex sibling
 * inside the shell's main row. The shell renders the registered node raw —
 * each page brings its own aside chrome (background, width, transitions).
 * Multiple pages can register; the last-registered wins.
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

/* -----------------------------------------------------------------------------
 * Sidebar visibility
 * Read by routes that want to render their own "open sidebar" affordance in a
 * top bar (e.g. /chat) instead of relying on the global floating button.
 * -------------------------------------------------------------------------- */

interface SidebarStateValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const SidebarStateContext = createContext<SidebarStateValue | null>(null);

export function useSidebarState(): SidebarStateValue {
  const ctx = use(SidebarStateContext);
  if (!ctx) {
    throw new Error("useSidebarState must be used inside AppShell");
  }
  return ctx;
}

/* -----------------------------------------------------------------------------
 * Viewport-driven sidebar collapse
 * Mirrors `useRailMode` from -preview-chat/helpers — same matchMedia + snap-on-
 * transition shape, but at a narrower breakpoint than the rail (1024px vs
 * 1280px) so the right rail collapses first and the sidebar follows once
 * we're firmly in tablet territory. Both default-open inline, default-closed
 * overlay; the user can still override manually after a transition.
 * -------------------------------------------------------------------------- */

const SIDEBAR_BREAKPOINT = "(min-width: 1024px)";
const LazyAuthedAppShell = lazy(() => import("./authed-app-shell"));

function useSidebarMode(): "inline" | "overlay" {
  const [mode, setMode] = useState<"inline" | "overlay">(() => {
    if (typeof window === "undefined") return "inline";
    return window.matchMedia(SIDEBAR_BREAKPOINT).matches ? "inline" : "overlay";
  });
  useEffect(() => {
    const mq = window.matchMedia(SIDEBAR_BREAKPOINT);
    const handler = () => setMode(mq.matches ? "inline" : "overlay");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return mode;
}

/* -------------------------------------------------------------------------- */

export function AppShell({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [rightRailNode, setRightRailNode] = useState<ReactNode | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sidebarMode = useSidebarMode();
  const [sidebarOpen, setSidebarOpen] = useState(() => sidebarMode === "inline");
  const [activeThread, setActiveThread] = useState<string>("");

  // Snap the sidebar back to each mode's default when the viewport
  // crosses the breakpoint — wide viewports get it open inline, narrow
  // viewports get it collapsed. Same during-render pattern as the
  // right-rail mode reset in `chat-shell.tsx`; the ref tracks the
  // previous mode so we only snap on the transition, not every render.
  const prevSidebarModeRef = useRef(sidebarMode);
  if (prevSidebarModeRef.current !== sidebarMode) {
    prevSidebarModeRef.current = sidebarMode;
    setSidebarOpen(sidebarMode === "inline");
  }

  /* Server-truth onboarding flag. Only fetched once we know we're authed; the
   * `enabled` keeps the query off the login screen. */
  const sessionUser = session?.user;

  /* Mirror resolved auth state into a synchronous localStorage hint so `/` can
   * decide on first paint — without blocking FCP on the session round-trip —
   * whether to show the landing (signed-out) or hold for the redirect
   * (signed-in). Written here because AppShell wraps every route, so the hint
   * stays fresh no matter which route the user entered through. */
  useEffect(() => {
    if (isPending) return;
    writeAuthHint(!!sessionUser);
  }, [isPending, sessionUser]);
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
   *   - finished user on /onboarding → / */
  const routeToOnboarding = onboardingQuery.data?.routeToOnboarding;
  const onOnboardingRoute = location.pathname.startsWith("/onboarding");
  useEffect(() => {
    if (!sessionUser) return;
    if (routeToOnboarding === undefined) return;
    if (routeToOnboarding && !onOnboardingRoute) {
      void navigate({ to: "/onboarding", search: { step: 1 } });
    } else if (!routeToOnboarding && onOnboardingRoute) {
      void navigate({ to: "/" });
    }
  }, [routeToOnboarding, onOnboardingRoute, sessionUser, navigate]);

  // Close the palette on route change. Tracking the previous location in a
  // ref (not state — we never read it in render) and resetting during render
  // replaces the prior useEffects that the linter flagged as derived-state
  // effects.
  const prevLocationRef = useRef(location);
  if (prevLocationRef.current !== location) {
    prevLocationRef.current = location;
    setPaletteOpen(false);
  }

  /* Routes that render edge-to-edge — no sidebar, no rail. `/` is in
   * this set because it owns its own layout: signed-out visitors see
   * the marketing landing, signed-in visitors get redirected to
   * `/chat`. Wrapping it in app chrome — even briefly during the
   * pending window — flashes "Memory / Notes / Skills…" at strangers
   * before the landing renders. */
  const chromeless =
    location.pathname === "/" ||
    location.pathname === "/login" ||
    location.pathname === "/privacy-policy" ||
    location.pathname === "/terms-of-service" ||
    location.pathname.startsWith("/onboarding");

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
  const sidebarStateValue = useMemo<SidebarStateValue>(
    () => ({ open: sidebarOpen, setOpen: setSidebarOpen }),
    [sidebarOpen],
  );
  const chatContextValue = useMemo(() => ({ activeThread, setActiveThread }), [activeThread]);

  // First-load gating: between "session resolved" and "onboarding query
  // resolved" we don't yet know whether to redirect new users to
  // /onboarding. Without this guard, the route's component paints for a
  // frame before the effect above navigates away. Render the chrome but
  // blank the main column until we know. This also covers `isPending`
  // implicitly: `onboardingQuery.enabled` is `!isPending && !!sessionUser`,
  // so while the session is loading `routeToOnboarding` stays `undefined`.
  const gatingPending = routeToOnboarding === undefined && !onOnboardingRoute;
  const mainContent = gatingPending ? null : children;

  // Chrome should be present for any non-chromeless route the user is
  // allowed to see — including the brief window where the session is
  // still resolving. Gating chrome on `authed` alone causes a flash
  // where ChatShell (and any other `h-full` route) renders parented by
  // `__root`'s `min-h-screen` wrapper, collapsing the hero to the top.
  const showChrome = !chromeless && (isPending || !!sessionUser);

  // Providers always wrap children — even on chromeless / unauthed paints —
  // so any route that calls `useChatContext` / `useSidebarState` on its
  // first render (before `useSession` resolves) doesn't trip the error
  // boundary. They're cheap state holders; no harm in providing them on
  // /login or while pending.
  return (
    <RightRailContext.Provider value={ctx}>
      <SidebarStateContext.Provider value={sidebarStateValue}>
        <ChatContext.Provider value={chatContextValue}>
          <AppThemeProvider>
            {showChrome ? (
              <Suspense fallback={<AuthedShellFallback />}>
                <LazyAuthedAppShell
                  pathname={location.pathname}
                  mainContent={mainContent}
                  rightRailNode={rightRailNode}
                  paletteOpen={paletteOpen}
                  setPaletteOpen={setPaletteOpen}
                  activeThread={activeThread}
                  sidebarOpen={sidebarOpen}
                  setSidebarOpen={setSidebarOpen}
                />
              </Suspense>
            ) : (
              children
            )}
          </AppThemeProvider>
        </ChatContext.Provider>
      </SidebarStateContext.Provider>
    </RightRailContext.Provider>
  );
}

function AuthedShellFallback() {
  return <div className="min-h-dvh bg-app-background-subtle" aria-hidden />;
}
