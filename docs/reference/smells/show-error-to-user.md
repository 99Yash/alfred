---
id: show-error-to-user
section: Frontend
status: stays-review
rung: none
---

# Show an error to the user.

Why: a failure that only reaches the console is a silent failure.

## Bad

```ts
} catch (err) {
  console.warn("[chat] attachment upload failed:", toMessage(err));
  return null;
}
```

## Good

```ts
} catch (err) {
  console.warn("[chat] attachment upload failed:", toMessage(err));
  toast.error(`Couldn't upload ${file.name}.`);
  return null;
}
```

The Good block is from `apps/web/src/lib/chat/use-send-message.ts`.

## Mechanism

Behavior, not shape.

A failure can reach the user through a toast, an error state or an inline message. A check cannot tell which path is correct for a surface.

## Hits
