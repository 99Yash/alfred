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
 * Cookie settings. `useSecureCookies` also sets the `__Secure-` name prefix, so keep it
 * with the attributes. Not `__Host-`: Better Auth cannot read a cookie with that prefix.
 */
export function authCookiePolicy(nodeEnv: ServerEnv["NODE_ENV"]): AuthCookiePolicy {
  if (nodeEnv === "production") {
    return {
      useSecureCookies: true,
      defaultCookieAttributes: {
        // Web and server are on different *.up.railway.app subdomains, a public suffix,
        // so requests are cross-site.
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
