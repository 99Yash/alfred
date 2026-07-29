import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

const TOOL_MODULES = [
  "gmail",
  "calendar",
  "docs",
  "drive",
  "sheets",
  "slides",
  "notion",
  "railway",
] as const;

const OLD_CREDENTIAL_DOOR =
  /\b(?:getFreshAccessToken|getActiveBearerCredential|listActiveBearerCredentials|resolveGoogleAccessToken)\b|\.accessToken\b/;

describe("integration facade cutover (#551)", () => {
  for (const module of TOOL_MODULES) {
    test(`${module} tools use the bound facade and never carry a provider token`, async () => {
      const source = await readFile(
        new URL(`../../src/modules/tools/${module}.ts`, import.meta.url),
        "utf8",
      );
      assert.match(source, /ctx\.integrations\./);
      assert.doesNotMatch(source, OLD_CREDENTIAL_DOOR);
    });
  }
});
