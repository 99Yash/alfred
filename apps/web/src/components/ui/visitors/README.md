# Visitors-now-grammar UI primitives

A second design language for Alfred, modeled on visitors.now. Lives alongside the existing dimension-grammar primitives — neither replaces the other yet.

**Why two systems?** Dimension-grammar (dark, layered glass, frosted hairlines) ships the landing page and the current app surfaces. Visitors-now-grammar (light, single elevation, tokenized hue scale, no ornament) is being evaluated as the new direction for data-dense app surfaces. The two coexist on this branch so we can A/B and migrate one route at a time.

See [`archive/visitors-now/design-notes.md`](../../../../archive/visitors-now/design-notes.md) for the full design study that informed these primitives.

## Opt-in model

Wrap any subtree in `.vs` to flip into visitors-now-grammar:

```tsx
<div className="vs min-h-dvh">
  {/* white background, fg-3 default text, -0.02em tracking,
      cursor:default applied to this subtree only */}
</div>
```

Everything outside a `.vs` ancestor is unaffected.

## Primitives

| Primitive       | What it is                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `VsButton`      | 32px-tall pill with the two-shadow elevation stack. Variants: white, primary, ghost, destructive.   |
| `VsCard`        | White-surface panel. Shadow-as-border, no border property. Optional `interactive` + `padded` props. |
| `VsCardHeader`  | Title-left, trailing-right row. Used as the first child of a `VsCard`.                              |
| `VsPill`        | Selector pill — "Today", "USD", "30 days". Optional leading icon + trailing chevron.                |
| `VsKpi`         | Label / value / delta stack. No card chrome.                                                        |
| `VsDock`        | Floating bottom-center dark pill for secondary nav. Active item highlights violet.                  |
| `VsHeader`      | Fixed top bar with masked-blur backdrop (no harsh edge against page content).                       |
| `VsInput`       | Pill input. `readOnly` flips to the muted `bg-vs-bg-2` token-display variant.                       |

## Tokens

All visitors-now tokens use the `vs-` prefix to avoid colliding with dimension tokens:

```
bg-vs-bg-{1..4}        backgrounds (1 = white, 4 = heaviest neutral fill)
bg-vs-bg-a{1..4}       black alphas (0.03, 0.05, 0.08, 0.12)
text-vs-fg-{1..4}      foreground (1 = disabled, 4 = brand ink #181925)
text-vs-fg-a{1..4}     alpha variants

bg-vs-{purple|green|red|amber|sky|blue|yellow|pink|orange|gray}-{1..4}
                       -1 = tint  -2 = soft / border  -3 = icon / chart  -4 = accent

ring-vs-purple-2       focus halo (paired with ring-offset-4)
shadow-[var(--vs-shadow-elevated)]   the two-shadow stack
rounded-vs-{1..6}      0.125rem → 1rem radius scale
```

## Utilities

| Class             | What it does                                                                       |
| ----------------- | ---------------------------------------------------------------------------------- |
| `.vs`             | Subtree opt-in: white bg, fg-3 text, -0.02em tracking, cursor:default.              |
| `.vs-elevated`    | Two-shadow stack (1px drop + 0-blur hairline). Bumps on hover.                     |
| `.vs-frost-header`| Masked backdrop-blur for fixed headers — fades to no-blur at the very top.         |
| `.vs-press`       | `active:scale(0.99)` press microinteraction. Used on every interactive primitive.  |

## Preview

Open `/preview/visitors-now` to see every primitive on one page. The dashboard pattern (header + KPI strip + chart placeholder + 2×2 card grid + dock) is replicated to match the visitors.now screenshots in the archive.

## Not yet built

- A11y tabs primitive matching the "Top | Entered | Exited" pattern in card headers.
- A `VsList` row primitive for the People page list-with-avatar-and-source layout.
- Empty-state primitive (small ringed icon + caption).
- Dark variant of every token (postponed by design — see scope decision on the original branch).
