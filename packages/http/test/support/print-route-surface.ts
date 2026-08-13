/**
 * The route-surface probe, as a standalone child program. One process, one `NODE_ENV`.
 *
 * `../route-surface-env.test.ts` spawns this once per pinned `NODE_ENV` value, under an
 * environment it builds from scratch, and reads the single JSON line it writes to stdout.
 * It exports nothing: the driver never imports it, it runs it. Its filename does not end
 * in `.test.ts`, so the `test/**\/*.test.ts` glob in `package.json` does not hand it to the
 * test runner as a suite.
 *
 * One process per value is not a cost the driver could avoid. ESM evaluates a specifier
 * once per process, so a loop over the values inside one process would find the barrel
 * already in the module cache and every row after the first would read green without
 * having measured anything.
 *
 * Usage: `node --import tsx test/support/print-route-surface.ts`, with `cwd` inside
 * `packages/http` so the `@alfred/http` self-reference resolves.
 *
 * The import is dynamic and this file loads nothing else, so the barrel evaluates under
 * exactly the environment the driver handed this process.
 */

// This program has no static import and no export of its own, so a parser cannot tell a
// module from a script and rejects the top-level `await` below — measured with `oxfmt`.
// The empty export makes the file a module and adds no name to the driver's vocabulary.
export {};

const { app } = await import("@alfred/http");

const routes = app.routes.map(({ method, path }) => `${method} ${path}`);

// The exit is the write's completion callback, not the next statement. A write to a pipe
// is asynchronous and `process.exit` does not flush, so exiting immediately would truncate
// the line at the pipe buffer. The exit still happens last, which is the point: a ref'd
// handle the barrel armed would otherwise hold this process open until the driver's
// timeout, and a timeout is reported as a spawn failure rather than as the route list.
process.stdout.write(`${JSON.stringify(routes)}\n`, () => process.exit(0));
