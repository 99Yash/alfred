---
id: accessible-controls
section: Frontend
status: review
rung: ast
feasibility: medium
---

# Make each control keyboard-reachable. Add ARIA where it is necessary. Do not use color as the only signal.

Why: the surface must work without a mouse and without color.

## Bad

```tsx
<AppCard
  onClick={() => onToggle(c.category)}
  className={cn("cursor-pointer p-4", active && "bg-app-purple-2")}
>
```

The card takes no focus, has no key handler, and shows the selection only by color.

## Good

```tsx
<AppCard
  role="button"
  tabIndex={0}
  aria-pressed={active}
  onClick={() => onToggle(c.category)}
  onKeyDown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle(c.category);
    }
  }}
  className={cn("cursor-pointer p-4", active && "ring-2 ring-app-purple-4")}
>
```

The Good block is a trim of `apps/web/src/routes/-settings/usage/category-cards.tsx`.

## Mechanism

Lint: the `jsx-a11y` plugin, one rule per change.

## Hits
