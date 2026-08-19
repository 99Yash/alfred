import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { authCookiePolicy } from "../src/cookie-policy";

describe("auth cookie policy (#454)", () => {
  test("uses secure cross-site cookies in production", () => {
    assert.deepEqual(authCookiePolicy("production"), {
      useSecureCookies: true,
      defaultCookieAttributes: {
        sameSite: "none",
        secure: true,
        httpOnly: true,
      },
    });
  });

  test("uses localhost-safe cookies in development and test", () => {
    for (const nodeEnv of ["development", "test"] as const) {
      assert.deepEqual(authCookiePolicy(nodeEnv), {
        useSecureCookies: false,
        defaultCookieAttributes: {
          sameSite: "lax",
          secure: false,
          httpOnly: true,
        },
      });
    }
  });

  test("accepts only a validated server environment", () => {
    // @ts-expect-error NODE_ENV is the ServerEnv union, not an arbitrary string.
    const invalidNodeEnv: Parameters<typeof authCookiePolicy>[0] = "Production";
    assert.equal(invalidNodeEnv, "Production");
  });

  test("requires one complete, internally consistent cookie state", () => {
    type CookiePolicy = ReturnType<typeof authCookiePolicy>;

    // @ts-expect-error The cookie policy cannot omit both required fields.
    const emptyPolicy: CookiePolicy = {};
    const partialPolicy: CookiePolicy = {
      useSecureCookies: true,
      // @ts-expect-error The cookie attributes must be complete.
      defaultCookieAttributes: { secure: true },
    };
    const mismatchedPolicy: CookiePolicy = {
      useSecureCookies: true,
      // @ts-expect-error A secure-prefixed cookie must also have the Secure attribute.
      defaultCookieAttributes: {
        sameSite: "none",
        secure: false,
        httpOnly: true,
      },
    };

    assert.deepEqual(
      [emptyPolicy, partialPolicy, mismatchedPolicy],
      [
        {},
        { useSecureCookies: true, defaultCookieAttributes: { secure: true } },
        {
          useSecureCookies: true,
          defaultCookieAttributes: { sameSite: "none", secure: false, httpOnly: true },
        },
      ],
    );
  });
});
