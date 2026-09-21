/**
 * Authorization opens in a NEW tab; the original tab refreshes on focus.
 *
 * Most call sites need one name: `openAuthorizationTab(url)`. Two cases need
 * more, and both are owned here:
 *
 * - `mcp-add-server-form` POSTs before it knows the authorize URL. A tab
 *   opened after `await` loses the user gesture and trips the popup blocker,
 *   so it calls `reserveAuthorizationTab()` in the click handler and
 *   `navigateAuthorizationTab(tab, url)` once the POST answers.
 * - The return tab (`root-layout` + `authorization-return-page`) reads
 *   `isAuthorizationReturnTab()` / `continueAfterAuthorization()`.
 *
 * Refresh on return has two layers: every `useIntegrationStatus` reader
 * refetches on window focus, and `useAuthorizationRefresh` (in
 * `routes/-integrations`) force-invalidates integration + MCP reads even
 * inside `staleTime` for the integrations page. All auth entry points —
 * integrations detail + MCP cards + add-server form, the three global
 * banners, onboarding, and both workflow recovery buttons — route through
 * this module, so no same-tab `window.location.href` connect remains.
 */
const AUTHORIZATION_TAB_KEY = "alfred:integration-authorization-tab";

const AUTHORIZATION_TAB_MAX_AGE_MS = 30 * 60_000;

/** Reserve a tab during the user gesture, before an async connection probe. */
export function reserveAuthorizationTab(): Window | null {
  const tab = window.open("about:blank", "_blank");

  if (!tab) return null;

  try {
    // The initial about:blank page shares this origin. Its session storage
    // stays with this tab through the provider redirect and the callback.
    tab.sessionStorage.setItem(AUTHORIZATION_TAB_KEY, String(Date.now()));
    tab.document.title = "Connecting to Alfred";
    tab.document.body.textContent = "Opening authorization…";
    tab.opener = null;

    return tab;
  } catch {
    tab.close();

    return null;
  }
}

/** Follow the browser redirect in the reserved tab, or in this tab if blocked. */
export function navigateAuthorizationTab(tab: Window | null, url: string): void {
  if (tab) {
    try {
      tab.location.replace(url);

      return;
    } catch {
      tab.close();
    }
  }

  window.location.assign(url);
}

export function openAuthorizationTab(url: string): void {
  navigateAuthorizationTab(reserveAuthorizationTab(), url);
}

/** Only a tab opened for this flow gets the completion screen. */
export function isAuthorizationReturnTab(): boolean {
  try {
    const startedAt = Number(window.sessionStorage.getItem(AUTHORIZATION_TAB_KEY));

    if (startedAt > 0 && Date.now() - startedAt < AUTHORIZATION_TAB_MAX_AGE_MS) return true;
  } catch {
    // Storage may be disabled. The normal callback destination remains usable.
  }

  return false;
}

export function continueAfterAuthorization(): void {
  window.sessionStorage.removeItem(AUTHORIZATION_TAB_KEY);
  window.location.reload();
}
