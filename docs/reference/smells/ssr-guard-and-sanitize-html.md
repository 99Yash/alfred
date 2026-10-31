---
id: ssr-guard-and-sanitize-html
section: Frontend
status: stays-review
rung: none
---

# Guard browser-only APIs for SSR. Sanitize HTML before you inject it.

Why: a server render has no `window`. Example: `apps/web/src/lib/storage/storage.ts`.

## Bad

```tsx
const draft = window.localStorage.getItem(draftKey);

return <div dangerouslySetInnerHTML={{ __html: message.html }} />;
```

## Good

```tsx
export function safeGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
```

The email body goes into a sandboxed iframe after DOMPurify runs on the server (`EmailHtmlFrame` in `apps/web/src/routes/-chat/rail/inbox-feed.tsx`).

## Mechanism

Behavior, not shape.

A check cannot tell code that runs only in the browser from code that also runs in a server render. It also cannot tell if a string is sanitized.

## Hits
