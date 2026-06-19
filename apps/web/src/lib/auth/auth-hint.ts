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
import { getLocalStorageItem, setLocalStorageItem } from "~/lib/storage/storage";

const KEY = "alfred.maybe-authed";

export function readAuthHint(): boolean {
  // SSR / private mode resolves to the schema default (`false`), i.e. "show the
  // landing" — the safe, fast default for the common signed-out visitor.
  return getLocalStorageItem(KEY);
}

export function writeAuthHint(authed: boolean): void {
  setLocalStorageItem(KEY, authed);
}
