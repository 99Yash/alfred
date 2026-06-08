/**
 * Synchronous, best-effort guess at whether the signed-in user has already
 * finished onboarding, for the very first paint — before the `/api/me/onboarding`
 * query has resolved its round-trip.
 *
 * Why this exists: `AppShell` must not paint an authed route for a frame and
 * then yank a brand-new user over to `/onboarding`, so it blanks the main
 * column until it knows `routeToOnboarding`. But that flag comes from a query
 * that is itself gated on the session resolving first — so on every hard
 * refresh the (already-onboarded) returning user stared at a blank column
 * behind *two* sequential network round-trips (session, then onboarding).
 *
 * The onboarding decision is httpOnly-cookie-gated server truth, so client JS
 * can't read it synchronously. Instead we mirror the *last known* resolved
 * state into localStorage (see `AppShell`) and read it back on first render: a
 * returning, onboarded user renders content immediately while the query
 * revalidates in the background.
 *
 * This is a UX hint, never a security/authorization boundary — a wrong guess
 * only costs a one-frame flash before the resolved query corrects course (the
 * same redirect effect still fires for a genuinely-not-onboarded user). Mirrors
 * `lib/auth-hint`.
 */
import { getLocalStorageItem, setLocalStorageItem } from "~/lib/storage";

const KEY = "alfred.onboarding-complete";

/**
 * Best-guess "has this user finished onboarding?" for first paint. Defaults to
 * `false` (the safe choice: keep blanking until we know, the correct behavior
 * for a genuinely new user) when there's no stored hint.
 */
export function readOnboardingHint(): boolean {
  return getLocalStorageItem(KEY);
}

export function writeOnboardingHint(complete: boolean): void {
  setLocalStorageItem(KEY, complete);
}
