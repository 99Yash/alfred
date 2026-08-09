# Elysia patterns

Elysia processes requests: `onRequest → transform → beforeHandle → handler → afterHandle → mapResponse → afterResponse`. Errors from any stage after routing jump to `onError`.

Key patterns in this repo:

```ts
// Auth guard via macro (packages/http/src/middleware/auth.ts)
app.use(authMacro).get("/protected", ({ user }) => user, { auth: true });

// Global error handler (packages/http/src/middleware/error-handler.ts)
// Normalises all errors to { error: string, code: string }.
// Throw an Errors.* factory from services; do not set.status manually.
// throw Errors.NotFoundError("Thread not found");
// Catch by code, not by class: if (isApiError(err, "CONFLICT")) …

// Session cache (packages/http/src/middleware/session-cache.ts)
// Call getSessionCached(request) — never auth().api.getSession() directly.
```

Plugin scope: hooks registered via `.use(plugin)` apply to routes defined after that call. Use `{ as: 'global' }` on `onError` to catch errors from all plugins.
