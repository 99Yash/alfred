import type { ServerEnv } from "@alfred/env/server";
import type { BetterAuthOptions } from "better-auth";

type BetterAuthAdvanced = NonNullable<BetterAuthOptions["advanced"]>;
type BetterAuthCookieAttributes = NonNullable<BetterAuthAdvanced["defaultCookieAttributes"]>;

type AuthCookiePolicy =
  | {
      useSecureCookies: Extract<NonNullable<BetterAuthAdvanced["useSecureCookies"]>, true>;
      defaultCookieAttributes: {
        sameSite: Extract<NonNullable<BetterAuthCookieAttributes["sameSite"]>, "none">;
        secure: Extract<NonNullable<BetterAuthCookieAttributes["secure"]>, true>;
        httpOnly: Extract<NonNullable<BetterAuthCookieAttributes["httpOnly"]>, true>;
      };
    }
  | {
      useSecureCookies: Extract<NonNullable<BetterAuthAdvanced["useSecureCookies"]>, false>;
      defaultCookieAttributes: {
        sameSite: Extract<NonNullable<BetterAuthCookieAttributes["sameSite"]>, "lax">;
        secure: Extract<NonNullable<BetterAuthCookieAttributes["secure"]>, false>;
        httpOnly: Extract<NonNullable<BetterAuthCookieAttributes["httpOnly"]>, true>;
      };
    };

/**
 * The browser transport policy for Better Auth cookies.
 *
 * `useSecureCookies` controls both the `secure` attribute and Better Auth's
 * `__Secure-` cookie name prefix. Keep that decision with the default cookie
 * attributes so one environment change cannot make the name and attributes
 * disagree.
 *
 * `__Host-` is stronger but not reachable here. Better Auth reads only the
 * `__Secure-<name>` and bare-name forms, so forcing `__Host-` through its
 * advanced cookie overrides would produce a cookie it cannot read itself.
 */
export function authCookiePolicy(nodeEnv: ServerEnv["NODE_ENV"]): AuthCookiePolicy {
  if (nodeEnv === "production") {
    return {
      useSecureCookies: true,
      defaultCookieAttributes: {
        // Web and server use different *.up.railway.app subdomains under a
        // Public Suffix List entry. Browser fetches are cross-site there, so
        // production needs None+Secure. Local HTTP development stays Lax.
        sameSite: "none",
        secure: true,
        httpOnly: true,
      },
    };
  }

  return {
    useSecureCookies: false,
    defaultCookieAttributes: {
      sameSite: "lax",
      secure: false,
      httpOnly: true,
    },
  };
}
