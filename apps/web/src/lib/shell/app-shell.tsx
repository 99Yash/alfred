import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  createContext,
  lazy,
  Suspense,
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";
import { ChatContext } from "~/components/chat-context";
import { AppThemeProvider } from "~/components/ui/v2/theme";
import { authClient } from "~/lib/auth/auth-client";
import { client } from "~/lib/eden";
import { useIsPublicRoute } from "~/lib/shell/public-route";
import type { ShellThreadViewModel } from "~/lib/shell/thread-view-model";
import {
  onboardingHintBelongsToAnotherUser,
  readOnboardingHint,
  writeOnboardingHint,
} from "~/lib/onboarding/onboarding-hint";
import { LOCAL_STORAGE_KEY, setLocalStorageItem } from "~/lib/storage/storage";
import { resolveSetState } from "~/lib/set-state";

/* Right-rail slot: `useRightRail(node)` mounts a page's own aside. The last one registered wins. */

interface RightRailContextValue {
  setContent: (node: ReactNode | null) => void;
}

const RightRailContext = createContext<RightRailContextValue | null>(null);

export function useRightRail(node: ReactNode | null) {
  const ctx = use(RightRailContext);
  useLayoutEffect(() => {
    if (!ctx) return;
    ctx.setContent(node);

    return () => ctx.setContent(null);
  }, [ctx, node]);
}

interface ShellThreadViewModelContextValue {
  setViewModel: (viewModel: ShellThreadViewModel | null) => void;
}

const ShellThreadViewModelContext = createContext<ShellThreadViewModelContextValue | null>(null);

export function useShellThreadViewModel(viewModel: ShellThreadViewModel) {
  const ctx = use(ShellThreadViewModelContext);
  useLayoutEffect(() => {
    if (!ctx) return;
    ctx.setViewModel(viewModel);

    return () => ctx.setViewModel(null);
  }, [ctx, viewModel]);
}

/* Sidebar visibility, for routes that draw their own "open sidebar" button. */

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

/* Sidebar collapse, like `useRailMode` but at 1024px, so the 1280px right rail collapses first. */

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

interface ShellState {
  rightRailNode: ReactNode | null;
  paletteOpen: boolean;
  sidebarOpen: boolean;
  activeThread: string;
  threadViewModel: ShellThreadViewModel | null;
}

type ShellAction =
  | { type: "setRightRailNode"; value: ReactNode | null }
  | { type: "setPaletteOpen"; value: SetStateAction<boolean> }
  | { type: "setSidebarOpen"; value: SetStateAction<boolean> }
  | { type: "setActiveThread"; value: string }
  | { type: "setThreadViewModel"; value: ShellThreadViewModel | null };

function createInitialShellState(sidebarMode: "inline" | "overlay"): ShellState {
  return {
    rightRailNode: null,
    paletteOpen: false,
    sidebarOpen: sidebarMode === "inline",
    activeThread: "",
    threadViewModel: null,
  };
}

const INERT_THREAD_VIEW_MODEL: ShellThreadViewModel = {
  groups: { pinned: [], today: [], yesterday: [], earlier: [] },
  recent: [],
};

function shellReducer(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    case "setRightRailNode":
      return { ...state, rightRailNode: action.value };
    case "setPaletteOpen":
      return { ...state, paletteOpen: resolveSetState(state.paletteOpen, action.value) };
    case "setSidebarOpen":
      return { ...state, sidebarOpen: resolveSetState(state.sidebarOpen, action.value) };
    case "setActiveThread":
      return { ...state, activeThread: action.value };
    case "setThreadViewModel":
      return { ...state, threadViewModel: action.value };
    default: {
      const _exhaustive: never = action;
      // SAFETY: unreachable; the cast only reads `type` for the message.
      throw new Error(`Unhandled shell action: ${(_exhaustive as ShellAction).type}`);
    }
  }
}

/* -------------------------------------------------------------------------- */

export function AppShell({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const sidebarMode = useSidebarMode();

  const [shellState, dispatchShell] = useReducer(
    shellReducer,
    sidebarMode,
    createInitialShellState,
  );

  const { rightRailNode, paletteOpen, sidebarOpen, activeThread, threadViewModel } = shellState;

  const setRightRailNode = useCallback(
    (value: ReactNode | null) => dispatchShell({ type: "setRightRailNode", value }),
    [],
  );

  const setPaletteOpen = useCallback(
    (value: SetStateAction<boolean>) => dispatchShell({ type: "setPaletteOpen", value }),
    [],
  );

  const setSidebarOpen = useCallback(
    (value: SetStateAction<boolean>) => dispatchShell({ type: "setSidebarOpen", value }),
    [],
  );

  const setActiveThread = useCallback(
    (value: string) => dispatchShell({ type: "setActiveThread", value }),
    [],
  );

  const setThreadViewModel = useCallback(
    (value: ShellThreadViewModel | null) => dispatchShell({ type: "setThreadViewModel", value }),
    [],
  );

  // On a breakpoint change only, reset the sidebar: open inline, closed as overlay.
  const [prevSidebarMode, setPrevSidebarMode] = useState(sidebarMode);

  if (prevSidebarMode !== sidebarMode) {
    setPrevSidebarMode(sidebarMode);
    setSidebarOpen(sidebarMode === "inline");
  }

  /* Server onboarding flag, fetched only when authed. */
  const sessionUser = session?.user;

  /* Auth hint in localStorage, so `/` can pick landing or redirect on first paint. */
  useEffect(() => {
    if (isPending) return;
    setLocalStorageItem(LOCAL_STORAGE_KEY.MAYBE_AUTHED, !!session?.user);
  }, [isPending, session?.user]);

  const { data: onboardingData } = useQuery({
    queryKey: ["me", "onboarding"],
    queryFn: async () => {
      const res = await client.api.me.onboarding.get();

      if (res.error) throw new Error("Failed to load onboarding state");

      return res.data;
    },
    enabled: !isPending && !!sessionUser,
    staleTime: 60_000,
    retry: 1,
  });

  const onOnboardingRoute = location.pathname.startsWith("/onboarding");

  /* Onboarding hint, so the next first paint does not wait on two round trips. */
  useEffect(() => {
    const nextRoute = onboardingData?.routeToOnboarding;

    if (nextRoute === undefined || !sessionUser?.id) return;
    writeOnboardingHint(sessionUser.id, !nextRoute);
  }, [onboardingData?.routeToOnboarding, sessionUser?.id]);

  /* Per user, so a stale `true` from a wiped account does not skip onboarding. */
  const onboardingHintComplete = readOnboardingHint(sessionUser?.id);
  useEffect(() => {
    const curId = sessionUser?.id;

    if (!curId) return;

    if (onboardingHintBelongsToAnotherUser(curId)) {
      // The hint belongs to another user.
      writeOnboardingHint(curId, false);
    }
  }, [sessionUser?.id]);
  // Redirect on the server flag, and on the hint while the query is pending.
  useEffect(() => {
    if (!session?.user) return;

    if (!onboardingHintComplete && !onOnboardingRoute) {
      const nextRoute = onboardingData?.routeToOnboarding;

      if (nextRoute === false) return;
      void navigate({ to: "/onboarding", search: { step: 1 } });

      return;
    }

    const nextRoute = onboardingData?.routeToOnboarding;

    if (nextRoute === undefined) return;

    if (nextRoute && !onOnboardingRoute) {
      void navigate({ to: "/onboarding", search: { step: 1 } });
    } else if (!nextRoute && onOnboardingRoute) {
      void navigate({ to: "/" });
    }
  }, [
    onboardingData?.routeToOnboarding,
    onOnboardingRoute,
    session?.user,
    navigate,
    onboardingHintComplete,
  ]);

  // Close the palette on route change, during render. State, not a ref: React can discard a render.
  const [prevLocation, setPrevLocation] = useState(location);

  if (prevLocation !== location) {
    const sameHref =
      prevLocation.pathname === location.pathname &&
      prevLocation.searchStr === location.searchStr &&
      prevLocation.hash === location.hash;

    setPrevLocation(location);

    if (!sameHref) {
      setPaletteOpen(false);
      setRightRailNode(null);
      setThreadViewModel(null);

      // Close the overlay drawer on any navigation. Inline mode stays open.
      if (sidebarMode === "overlay") setSidebarOpen(false);
    }
  }

  /* Public routes have no chrome and skip the auth guard. See `lib/shell/public-route.ts`. */
  const chromeless = useIsPublicRoute();

  /* Auth guard: send a signed-out visitor to `/login?redirect=`. Never while the session is pending. */
  const pathname = location.pathname;
  const onPreviewChatRoute = pathname === "/preview/chat" || pathname.startsWith("/preview/chat/");
  const mustRedirectToLogin = !isPending && !sessionUser && !chromeless;
  useEffect(() => {
    if (!mustRedirectToLogin) return;
    const target = location.pathname + location.searchStr;
    void navigate({
      to: "/login",
      search: { redirect: target === "/" ? undefined : target },
      replace: true,
    });
  }, [mustRedirectToLogin, location.pathname, location.searchStr, navigate]);

  // ⌘K toggles the palette. ⌘J starts a new chat, because the browser keeps ⌘N.
  const authed = !isPending && !!session?.user && !chromeless;
  const togglePaletteEvent = useEffectEvent(() => setPaletteOpen((o) => !o));
  const newChatEvent = useEffectEvent(() => void navigate({ to: "/chat" }));
  useEffect(() => {
    if (!authed) return;

    const onKey = (e: KeyboardEvent) => {
      // No `isEditableTarget` guard: the composer is contenteditable and would block them.
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        togglePaletteEvent();
      } else if (
        e.key.toLowerCase() === "j" &&
        e.metaKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        newChatEvent();
      }
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, [authed]);

  const ctx = useMemo<RightRailContextValue>(
    () => ({ setContent: setRightRailNode }),
    [setRightRailNode],
  );

  const sidebarStateValue = useMemo<SidebarStateValue>(
    () => ({ open: sidebarOpen, setOpen: setSidebarOpen }),
    [sidebarOpen, setSidebarOpen],
  );

  const chatContextValue = useMemo(
    () => ({ activeThread, setActiveThread }),
    [activeThread, setActiveThread],
  );

  const shellThreadViewModelContextValue = useMemo(
    () => ({ setViewModel: setThreadViewModel }),
    [setThreadViewModel],
  );

  // Render at once; the redirect effect moves a non-onboarded user later.
  const mainContent = children;

  // Show chrome while the session resolves too; otherwise `h-full` routes collapse for a frame.
  const showChrome = !chromeless && (isPending || !!sessionUser);

  // Always provide context, so a hook on the first render does not throw.
  return (
    <RightRailContext.Provider value={ctx}>
      <ShellThreadViewModelContext.Provider value={shellThreadViewModelContextValue}>
        <SidebarStateContext.Provider value={sidebarStateValue}>
          <ChatContext.Provider value={chatContextValue}>
            <AppThemeProvider>
              {showChrome ? (
                <Suspense fallback={<AuthedShellFallback />}>
                  <LazyAuthedAppShell
                    mainContent={mainContent}
                    rightRailNode={rightRailNode}
                    paletteOpen={paletteOpen}
                    setPaletteOpen={setPaletteOpen}
                    activeThread={activeThread}
                    sidebarOpen={sidebarOpen}
                    setSidebarOpen={setSidebarOpen}
                    sidebarMode={sidebarMode}
                    threadViewModel={
                      onPreviewChatRoute
                        ? (threadViewModel ?? INERT_THREAD_VIEW_MODEL)
                        : threadViewModel
                    }
                  />
                </Suspense>
              ) : mustRedirectToLogin ? (
                // The /login redirect is in flight; show a blank frame.
                <AuthedShellFallback />
              ) : (
                children
              )}
            </AppThemeProvider>
          </ChatContext.Provider>
        </SidebarStateContext.Provider>
      </ShellThreadViewModelContext.Provider>
    </RightRailContext.Provider>
  );
}

function AuthedShellFallback() {
  return <div className="min-h-dvh bg-app-background-subtle" aria-hidden />;
}
