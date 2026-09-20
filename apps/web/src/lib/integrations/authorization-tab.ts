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
