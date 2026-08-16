// Fixtures for the prose-locator rule. A clean run of a check that cannot see a
// rotted locator is indistinguishable from a clean run of a check that works, so
// every case here asserts the MUTATION fails and its clean twin passes.
//
// `scripts/` has no CI test job and no tsconfig names the tree, so this suite is
// run by `check-prose-locators.mjs` itself — the same wiring the other check
// suites use. A test file that only a job which does not exist would run is a
// dead guard.

import { proseLocatorFailures } from "./prose-locators.mjs";

/** One workspace-package entry in the shape `workspaceExportIndex` builds. */
function packageEntry(name, dir, exportsMap) {
  const keys = new Map();
  for (const [subpath, target] of Object.entries(exportsMap)) {
    keys.set(
      subpath,
      target === null ? { blocked: true, targets: [] } : { blocked: false, targets: [target] },
    );
  }
  return [name, { dir, keys, problem: null }];
}

const SYNC = packageEntry("@alfred/sync", "packages/sync", {
  ".": "./src/index.ts",
  "./*": "./src/*",
});
const LISTED_SYNC = ["packages/sync/src/index.ts", "packages/sync/src/foo.ts"];

function run(docs, sources, listed, packages, allowed) {
  return proseLocatorFailures({
    docs,
    sources,
    packages: new Map(packages),
    listed: new Set(listed),
    allowed,
  });
}

function clean(docs, sources, listed, packages, allowed) {
  return run(docs, sources, listed, packages, allowed).failures;
}

function expectClean(label, failures, report) {
  if (report.length === 0) return;
  report.push(`${label}: expected no failures, received ${JSON.stringify(report)}`);
}

function expectFailure(label, failures, report, needles) {
  if (report.length === 0) {
    failures.push(`${label}: expected a reported failure, received none`);
    return;
  }
  const joined = report.join("\n");
  for (const needle of needles) {
    if (!joined.includes(needle)) {
      failures.push(
        `${label}: expected the failure to mention ${JSON.stringify(needle)}, received ${joined}`,
      );
    }
  }
}

export function proseLocatorSelfTestFailures() {
  const failures = [];

  expectFailure(
    "a dead subpath on a live package",
    failures,
    clean(
      [{ file: "docs/x.md", text: "writes through `@alfred/sync/nope` here." }],
      [],
      ["packages/sync/src/index.ts"],
      [packageEntry("@alfred/sync", "packages/sync", { ".": "./src/index.ts" })],
    ),
    ["does not publish"],
  );

  expectFailure(
    "a dead repo path in present-tense prose",
    failures,
    clean(
      [{ file: "apps/web/src/README.md", text: "ships behind `apps/web/Caddyfile`." }],
      [],
      ["apps/web/src/main.tsx"],
      [],
    ),
    ["no git-listed file or directory"],
  );

  expectClean(
    "a bare mention of a declared workspace is identity, not an import",
    failures,
    clean(
      [{ file: "docs/x.md", text: "the transport lives behind `@alfred/sync` subpaths." }],
      [],
      LISTED_SYNC,
      [SYNC],
    ),
  );

  expectFailure(
    "a bare mention of a deleted package",
    failures,
    clean(
      [{ file: "docs/x.md", text: "writes through `@alfred/api` subpaths." }],
      [],
      LISTED_SYNC,
      [SYNC],
    ),
    ["no workspace package declares"],
  );

  expectClean(
    "a span whose sentence narrates its former home",
    failures,
    clean(
      [
        {
          file: "CONTEXT.md",
          text: "the transport used to live in `@alfred/api` — it moved here.",
        },
      ],
      [],
      LISTED_SYNC,
      [SYNC],
    ),
  );

  expectClean(
    "placeholder spans are patterns, not names",
    failures,
    clean(
      [
        {
          file: "docs/x.md",
          text: "one file per `packages/sync/src/mutators/<entity>.ts`.\nAnd `@alfred/assistant/knowledge/…` stays open.\nThe font is `OpenRunde-{Medium,Semibold}.woff2`.",
        },
      ],
      [],
      LISTED_SYNC,
      [SYNC],
    ),
  );

  expectClean(
    "a span whose sentence asserts its own absence",
    failures,
    clean(
      [
        {
          file: "CONTEXT.md",
          text: "There is no `packages/assistant/src/meeting-prep/` — the flow was never built.",
        },
      ],
      [],
      [],
      [],
    ),
  );

  expectClean(
    "a wildcard subpath that matches the exported family",
    failures,
    clean(
      [{ file: "docs/x.md", text: "call `@alfred/sync/foo` through the door." }],
      [],
      LISTED_SYNC,
      [SYNC],
    ),
  );

  expectFailure(
    "a wildcard subpath whose family matches no git-listed file",
    failures,
    clean(
      [{ file: "docs/x.md", text: "call `@alfred/sync/bar` through the door." }],
      [],
      ["packages/sync/src/index.ts"],
      [SYNC],
    ),
    ["no file git lists"],
  );

  expectFailure(
    "a subpath the package's exports map seals",
    failures,
    clean(
      [{ file: "docs/x.md", text: "reach `@alfred/sync/secret` from the app." }],
      [],
      LISTED_SYNC,
      [packageEntry("@alfred/sync", "packages/sync", { ".": "./src/index.ts", "./secret": null })],
    ),
    ["SEALS"],
  );

  expectFailure(
    "an ALLOWED entry without a reason",
    failures,
    clean([], [], [], [], new Map([["docs/x.md:`apps/server/.env`", "  "]])),
    ["has no reason"],
  );

  expectFailure(
    "an ALLOWED entry no span matches",
    failures,
    clean([], [], [], [], new Map([["docs/x.md:`apps/server/.env`", "env file created at boot"]])),
    ["matched no span"],
  );

  expectFailure(
    "a gitignored artifact without an ALLOWED entry",
    failures,
    clean(
      [{ file: "docs/x.md", text: "secrets sit in `apps/server/.env`." }],
      [],
      ["apps/server/src/main.ts"],
      [],
    ),
    ["no git-listed file or directory"],
  );

  expectClean(
    "a gitignored artifact with an ALLOWED entry and a reason",
    failures,
    clean(
      [{ file: "docs/x.md", text: "secrets sit in `apps/server/.env`." }],
      [],
      ["apps/server/src/main.ts"],
      [],
      new Map([["docs/x.md:`apps/server/.env`", "env file created at boot, gitignored by design"]]),
    ),
  );

  expectFailure(
    "a dead path inside a source comment",
    failures,
    clean(
      [],
      [
        {
          file: "packages/assistant/src/a.ts",
          text: 'const hint = "http://x//y `apps/web/Caddyfile`";\n// writes through `apps/web/Caddyfile`\n',
        },
      ],
      ["apps/web/src/main.tsx"],
      [],
    ),
    ["no git-listed file or directory"],
  );

  expectClean(
    "a string literal that merely quotes a path is code, not prose",
    failures,
    clean(
      [],
      [
        {
          file: "packages/assistant/src/a.ts",
          text: 'const hint = "http://x//y `apps/web/Caddyfile`";\n',
        },
      ],
      ["apps/web/src/main.tsx"],
      [],
    ),
  );

  return failures;
}
