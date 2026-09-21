import { useMatches } from "@tanstack/react-router";

/**
 * `staticData: { publicRoute: true }` — the route declares, on itself, that it
 * renders without the app chrome and without a session.
 *
 * ONE FLAG, TWO EFFECTS, and they must stay welded together. `AppShell` reads
 * it to skip the sidebar and the right rail, AND to skip the signed-out
 * redirect to `/login`. A route that renders edge-to-edge but still redirects
 * is unreachable by the only audience it has; a route that skips the redirect
 * but keeps the chrome shows "Memory / Notes / Skills…" to a stranger. Neither
 * half is useful alone, so neither gets its own flag.
 *
 * This used to be a hardcoded `||` chain of pathnames inside `AppShell`. The
 * chain failed in the direction nobody tests: a new signed-out route omitted
 * from it redirects its visitor to `/login`, and a signed-in developer — who is
 * never redirected — sees only the wrong chrome and calls it cosmetic. Moving
 * the declaration onto the route puts it in the file the author is already
 * editing, in the same object as `component` and `head`.
 */
declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /**
     * Reachable with no session, and rendered edge-to-edge. Declare it on the
     * same day the route is written; see the notes above for why the two
     * effects are one flag.
     */
    publicRoute?: boolean;
  }
}

/**
 * Whether the route being rendered is public.
 *
 * Reads the match chain rather than the pathname, so a nested route inherits
 * the flag from its public parent and no prefix string has to be maintained.
 * `state.matches` already holds the DESTINATION matches while their loaders are
 * still pending, so this flips at the start of a navigation, not at its end —
 * which is what keeps the chrome from flashing over a landing page mid-route.
 */
export function useIsPublicRoute(): boolean {
  return useMatches({
    select: (matches) => matches.some((match) => match.staticData.publicRoute === true),
  });
}
