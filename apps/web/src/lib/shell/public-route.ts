import { useMatches, useRouterState, type StaticDataRouteOption } from "@tanstack/react-router";

/**
 * One flag, two effects: no app chrome and no `/login` redirect. Either alone is a bug:
 * a stranger gets redirected, or sees the app chrome.
 */
declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** Reachable with no session, rendered without chrome. */
    publicRoute?: boolean;
  }
}

function hasPublicMatch(matches: ReadonlyArray<{ staticData: StaticDataRouteOption }>): boolean {
  return matches.some((match) => match.staticData.publicRoute === true);
}

/**
 * Reads the match chain, so a nested route inherits the flag. The matches stay the previous
 * route's while loaders run, so chrome does not flash mid-navigation.
 */
export function useIsPublicRoute(): boolean {
  return useMatches({ select: hasPublicMatch });
}

/**
 * The href the auth guard must protect, or `undefined` when there is none. While a navigation
 * loads, `location` is already the destination's but the matches are still the previous
 * route's, so `useLocation()` beside `useIsPublicRoute()` can pair `/login` with a private
 * flag. One snapshot, read only once the router is idle, keeps the href and the flag in step.
 */
export function usePrivateRouteHref(): string | undefined {
  return useRouterState({
    select: (state) =>
      state.status === "idle" && !hasPublicMatch(state.matches)
        ? state.location.pathname + state.location.searchStr
        : undefined,
  });
}
