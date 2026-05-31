/**
 * Synchronous, best-effort guess at whether the visitor is signed in, for the
 * very first paint — before `authClient.useSession()` has resolved its
 * round-trip.
 *
 * The session cookie is httpOnly, so client JS can't read auth state
 * synchronously. Instead we mirror the *last known* resolved state into
 * localStorage (see `AppShell`) and read it back on first render. The `/`
 * route uses it to decide, before the session resolves, whether to paint the
 * marketing landing immediately (signed-out → fast FCP) or hold a blank frame
 * for the `/chat` redirect (signed-in → no landing flash).
 *
 * This is a UX hint, never a security boundary — a wrong guess only costs a
 * one-frame flash or a brief blank, and the next resolved session corrects it.
 */
const KEY = "alfred.maybe-authed";

export function readAuthHint(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    // Private mode / storage disabled — no hint means "show the landing",
    // which is the safe, fast default for the common signed-out visitor.
    return false;
  }
}

export function writeAuthHint(authed: boolean): void {
  try {
    localStorage.setItem(KEY, authed ? "1" : "0");
  } catch {
    // Ignore — storage unavailable; we just lose flash-avoidance on next load.
  }
}
