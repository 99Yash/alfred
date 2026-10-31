---
id: effect-cleanup
section: Frontend
status: stays-review
rung: none
---

# Clean up each subscription and timer in an effect. Do not set state after unmount.

Why: a subscription that stays open after unmount leaks, and its late callback writes stale state. Example: `apps/web/src/routes/-chat/composer/use-steer-modifier.ts`.

## Bad

```ts
useEffect(() => {
  const onKeyDown = () => {
    timer = window.setTimeout(() => setHeld(true), ARM_DELAY_MS);
  };
  window.addEventListener("keydown", onKeyDown, true);
}, [scope, enabled]);
```

## Good

```ts
useEffect(() => {
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", reset);

  return () => {
    reset(); // clears the timer and the held state
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", reset);
  };
}, [scope, enabled]);
```


## Mechanism

`react/exhaustive-deps` checks the dependency array. Whether an effect owns a resource to release is behavior.

## Hits
