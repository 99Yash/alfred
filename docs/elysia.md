# Elysia patterns

Elysia processes requests: `onRequest → transform → beforeHandle → handler → afterHandle → mapResponse → afterResponse`. Errors from any stage after routing jump to `onError`.

Key patterns in this repo:

```ts
// Auth guard via macro (packages/api/src/middleware/auth.ts)
app.use(authMacro).get("/protected", ({ user }) => user, { auth: true });

// Global error handler (packages/api/src/middleware/error-handler.ts)
// Normalises all errors to { error: string, code: string }.
// Throw ApiError subclasses from services; do not set.status manually.

// Session cache (packages/api/src/middleware/session-cache.ts)
// Call getSessionCached(request) — never auth().api.getSession() directly.
```

Plugin scope: hooks registered via `.use(plugin)` apply to routes defined after that call. Use `{ as: 'global' }` on `onError` to catch errors from all plugins.
