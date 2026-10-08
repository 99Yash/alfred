import { useMatches } from "@tanstack/react-router";

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

/**
 * Reads the match chain, so a nested route inherits the flag. The matches are the
 * destination's while loaders run, so chrome does not flash mid-navigation.
 */
export function useIsPublicRoute(): boolean {
  return useMatches({
    select: (matches) => matches.some((match) => match.staticData.publicRoute === true),
  });
}
