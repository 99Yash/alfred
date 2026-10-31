---
id: delta-class-across-component
section: Frontend
status: stays-review
rung: none
---

# Do not pass a same-property Tailwind utility through `className` to a primitive that carries a delta class.

The interactive `components/ui/v2` primitives and `FrostButton` carry `app-press`, so gate a `scale-*` utility that you pass to them with `not-active:`. `alfred/no-delta-class-utility-collision` checks the classes of one element in one file. It cannot see a class that crosses a component boundary.

Why: the delta classes sit in `@layer components`, so the utility wins, and the press stops with no error. Example: `hover:not-active:scale-[1.04]` in `apps/web/src/routes/-chat/composer/composer-toolbar.tsx`.

## Bad

```tsx
<FrostButton tone="light" size="lg" className="hover:scale-[1.04]" onClick={onGetStarted}>
  Get started
</FrostButton>
```

`FrostButton` adds `app-press`, which writes `scale` on `:active`. The `hover:scale-*` utility wins, so the press does not show.

## Good

```tsx
<FrostButton tone="light" size="lg" className="hover:not-active:scale-[1.04]" onClick={onGetStarted}>
  Get started
</FrostButton>
```

## Mechanism

`alfred/no-delta-class-utility-collision` reads one element in one file. The class and the delta meet only after a component renders.

## Hits
