/**
 * Child program for `../route-surface-env.test.ts`: prints the mounted routes as one JSON line.
 * Run with `node --import tsx` and `cwd` in `packages/http`, so the self-reference resolves.
 * A deliberate copy of `packages/assistant/test/support/import-probe.ts` (`rootDir` blocks a
 * shared import). Change one copy and read the other.
 */

// Makes the file a module, so the top-level `await` parses.
export {};

const { app } = await import("@alfred/http");

const routes = app.routes.map(({ method, path }) => `${method} ${path}`);

// Exit in the write callback: `process.exit` does not flush a pipe.
// Exit at all, because a ref'd handle from the barrel would hold the process until timeout.
process.stdout.write(`${JSON.stringify(routes)}\n`, () => process.exit(0));
