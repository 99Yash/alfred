import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

/**
 * `src/chat.ts` holds transport only; product logic lives in `@alfred/assistant/chat` (ADR-0089).
 * A route that decides state must import a database, Redis, storage, or `drizzle-orm`,
 * so a forbidden specifier is the regression. This reports a regression; it does not prevent one.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ROUTE_FILE = path.join(HERE, "..", "src", "chat.ts");

/** Every module specifier the file imports, static or dynamic. */
export function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*)(["'])([^"']+)\1/g;

  for (const match of source.matchAll(pattern)) {
    const specifier = match[2];

    if (specifier) found.push(specifier);
  }

  return found;
}

/** `@alfred/assistant` is allowed only through the `chat` barrel. */
const FORBIDDEN: readonly {
  readonly matches: (specifier: string) => boolean;
  readonly why: string;
}[] = [
  {
    matches: (s) => s === "@alfred/db" || s.startsWith("@alfred/db/"),
    why: "a database or Redis address means this file decides what is persisted",
  },
  {
    matches: (s) => s === "drizzle-orm" || s.startsWith("drizzle-orm/"),
    why: "a query operator means this file builds a query",
  },
  {
    matches: (s) =>
      s === "@alfred/assistant/execution" || s.startsWith("@alfred/assistant/execution/"),
    why: "run persistence and redelivery belong to turn admission",
  },
  {
    matches: (s) =>
      s === "@alfred/assistant/triggers" || s.startsWith("@alfred/assistant/triggers/"),
    why: "emitting a sync poke is a decision about state that already changed",
  },
  {
    matches: (s) => s.startsWith("@alfred/assistant/connections"),
    why: "queueing ingestion work belongs to the module that owns the bytes",
  },
  {
    matches: (s) => s.startsWith("@alfred/assistant/chat/"),
    why: "the four seam functions on the module barrel are the whole door; a deep reach takes a decision the module owns",
  },
];

describe("packages/http/src/chat.ts is transport only", () => {
  const specifiers = importSpecifiers(readFileSync(ROUTE_FILE, "utf8"));

  test("the file imports something, so an empty read cannot pass this suite", () => {
    assert.ok(
      specifiers.includes("elysia"),
      `expected to have read the route file; got ${specifiers.length} specifiers`,
    );
  });

  test("it names no database, Redis, storage or query address", () => {
    const violations = specifiers.flatMap((specifier) => {
      const rule = FORBIDDEN.find((candidate) => candidate.matches(specifier));

      return rule ? [`${specifier} — ${rule.why}`] : [];
    });

    assert.deepEqual(
      violations,
      [],
      `packages/http/src/chat.ts holds transport only. Move the decision into ` +
        `@alfred/assistant/chat and call it from here.\n  ${violations.join("\n  ")}`,
    );
  });

  test("it reaches the product module through the chat barrel", () => {
    assert.ok(
      specifiers.includes("@alfred/assistant/chat"),
      "the routes must call the product seam, not reimplement it",
    );
  });
});
