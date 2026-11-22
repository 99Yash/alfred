import { enumGuard } from "./guards";

/**
 * The OAuth error codes that a failed provider callback can carry to the web app, as
 * `?<provider>_error=<code>` (RFC 6749 §4.1.2.1). `unknown` stands for any other value. The raw
 * provider value never goes into the redirect, so no link can put its own text on an Alfred page.
 */
const OAUTH_CALLBACK_ERROR_CODES = [
  "access_denied",
  "invalid_request",
  "unauthorized_client",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "unknown",
] as const;

export type OAuthCallbackErrorCode = (typeof OAUTH_CALLBACK_ERROR_CODES)[number];

const isOAuthCallbackErrorCode = enumGuard(OAUTH_CALLBACK_ERROR_CODES);

/** The query keys that carry a callback error. Each provider callback sends only its own key. */
export const OAUTH_CALLBACK_ERROR_PARAMS = ["github_error", "vercel_error"] as const;

/** The known code for a provider value, or `unknown`. Use it at both ends of the redirect. */
export function parseOAuthCallbackErrorCode(value: string): OAuthCallbackErrorCode {
  return isOAuthCallbackErrorCode(value) ? value : "unknown";
}
