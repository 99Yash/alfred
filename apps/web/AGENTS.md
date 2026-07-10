# Alfred Web Guidance

## Browser Boundary

- Browser runtime code may import browser-safe packages such as `@alfred/contracts` and `@alfred/sync`. It must not import runtime values from `@alfred/api`, `@alfred/auth`, `@alfred/db`, `@alfred/env`, or `@alfred/ai`.
- A type-only import from a server package is acceptable only when it is declared with `import type` and erased from the bundle. Do not rely on a type annotation to make a value import safe.
- Run `pnpm check:web-boundaries` after changing imports near `apps/web`.

## Feature Ownership

- Keep route entry files thin: route declaration, search/param validation, loaders, and composition only.
- Colocate a feature's components, hooks, state, schemas, and helpers with that feature. The feature owns its implementation; other features should consume its public surface rather than reach into private files.
- Put code in top-level `components`, `hooks`, or `lib` only when it is genuinely generic and used across features. Similar-looking feature code is not automatically shared infrastructure.

## Preview And Debug Isolation

- Preview and debug routes are development surfaces, not production dependencies. Production routes and features must not import their fixtures, route modules, or debug-only helpers; previews may compose production components instead.
- Preview/debug code must not trigger production writes, background work, analytics, or provider calls. Gate the route itself from production when it exposes internal data or controls.

## Data And Storage

- Treat URL params, storage, SSE messages, preview JSON, and provider metadata as untrusted. Parse with the owning browser-safe schema or contracts guard before reading fields.
- Do not add local record or JSON parsing helpers when `@alfred/contracts` owns the boundary behavior.
- Do not call `window.localStorage` outside `apps/web/src/lib/storage/storage.ts`.
- Static localStorage keys must be registered in `apps/web/src/lib/storage/storage-schemas.ts` and read/written via `getLocalStorageItem`, `setLocalStorageItem`, or `subscribeToStorage`.
- Dynamic or per-entity localStorage keys may use `safeGet`, `safeSet`, and `safeRemove` directly; keep their parsing at the owning feature boundary.
- Prefer existing Replicache and storage abstractions over direct IndexedDB access. Wrap repeated use of other browser storage APIs rather than scattering calls.

## React Correctness

- Derive values during render; do not mirror props into state with an effect merely to reset derived UI. Key a stateful subtree when identity changes.
- Effects synchronize with external systems. Clean up subscriptions, timers, object URLs, and pending work, and avoid stale closures or post-unmount updates.
- Use stable domain IDs for list keys and place `key` directly on the rendered JSX element.
- Render loading, error, empty, and populated states for every asynchronous surface, and keep browser-only APIs SSR-safe.
