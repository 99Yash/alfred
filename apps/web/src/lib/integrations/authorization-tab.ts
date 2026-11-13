/**
 * Authorization opens in a new tab; the original tab refreshes on focus.
 * A tab opened after `await` trips the popup blocker, so async callers reserve
 * it in the click handler and navigate it later.
 */
const AUTHORIZATION_TAB_KEY = "alfred:integration-authorization-tab";

const AUTHORIZATION_TAB_MAX_AGE_MS = 30 * 60_000;

/** Reserve a tab during the user gesture, before an async connection probe. */
export function reserveAuthorizationTab(): Window | null {
  const tab = window.open("about:blank", "_blank");

  if (!tab) return null;

  try {
    // about:blank shares this origin; its session storage survives the provider redirect.
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

/** A provider callback that fails sends `?<provider>_error=<code>`, for example `github_error`. */
const CALLBACK_ERROR_PARAM_SUFFIX = "_error";

/** RFC 6749 §4.1.2.1: the user refused the consent screen. */
const OAUTH_ACCESS_DENIED = "access_denied";

/**
 * The GitHub App connected, but its grant did not open chat reads. Not a refusal: GitHub is
 * connected. The value is `auth_required` or `failed`; the GitHub page shows the detail.
 */
const GITHUB_MCP_ERROR_PARAM = "github_mcp_error";

/**
 * A callback outcome for the user: a short title and one sentence. `refused`: nothing changed.
 * `partial`: the connect worked, but one part of it did not.
 */
export interface AuthorizationError {
  readonly kind: "refused" | "partial";
  readonly title: string;
  readonly description: string;
}

/** The callback error in `search` for the user, or `null` when there is none. */
export function readAuthorizationError(search: string): AuthorizationError | null {
  const params = new URLSearchParams(search);
  const grantCode = params.get(GITHUB_MCP_ERROR_PARAM);

  for (const [key, code] of params) {
    if (key === GITHUB_MCP_ERROR_PARAM || !key.endsWith(CALLBACK_ERROR_PARAM_SUFFIX) || !code) {
      continue;
    }

    return {
      kind: "refused",
      title: "Not connected",
      description:
        code === OAUTH_ACCESS_DENIED
          ? "You declined access. Nothing changed."
          : `The provider sent back "${code}". Nothing changed.`,
    };
  }

  if (!grantCode) return null;

  return {
    kind: "partial",
    title: "GitHub connected",
    description:
      grantCode === "auth_required"
        ? "Chat can't read GitHub until you grant access. Open GitHub in Integrations."
        : "Chat can't read GitHub yet. Open GitHub in Integrations to retry.",
  };
}

export function continueAfterAuthorization(): void {
  window.sessionStorage.removeItem(AUTHORIZATION_TAB_KEY);
  window.location.reload();
}
