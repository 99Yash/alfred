# App-grammar UI primitives

Alfred's production app design language, modeled on visitors.now. Older dimension versions of duplicated primitives are isolated in `../legacy` for the development styleguide and the existing dimension-styled global error fallback.

New production app surfaces should use the `App*` exports here. The legacy set has materially different visual and prop contracts and is not a second generic production namespace.

The full design study that informed these primitives lives at `archive/visitors-now/design-notes.md` in the repo root — a local-only, git-ignored snapshot, so it won't be present in a fresh clone.

## Opt-in model

Wrap any subtree in `.app` to flip into app-grammar:

```tsx
<div className="app min-h-dvh">
  {/* white background, fg-3 default text, -0.02em tracking,
      cursor:default applied to this subtree only */}
</div>
```

Everything outside a `.app` ancestor is unaffected.

## Primitives

| Primitive       | What it is                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `AppButton`     | 32px-tall pill with the two-shadow elevation stack. Variants: white, primary, ghost, destructive.   |
| `AppCard`       | White-surface panel. Shadow-as-border, no border property. Optional `interactive` + `padded` props. |
| `AppCardHeader` | Title-left, trailing-right row. Used as the first child of a `AppCard`.                             |
| `AppPill`       | Selector pill — "Today", "USD", "30 days". Optional leading icon + trailing chevron.                |
| `AppKpi`        | Label / value / delta stack. No card chrome.                                                        |
| `AppDock`       | Floating bottom-center dark pill for secondary nav. Active item highlights violet.                  |
| `AppHeader`     | Fixed top bar with masked-blur backdrop (no harsh edge against page content).                       |
| `AppInput`      | Pill input. `readOnly` flips to the muted `bg-app-bg-2` token-display variant.                      |

## Tokens

All app tokens use the `app-` prefix to avoid colliding with dimension tokens:

```
bg-app-bg-{1..4}        backgrounds (1 = white, 4 = heaviest neutral fill)
bg-app-bg-a{1..4}       black alphas (0.03, 0.05, 0.08, 0.12)
text-app-fg-{1..4}      foreground (1 = disabled, 4 = brand ink #181925)
text-app-fg-a{1..4}     alpha variants

bg-app-{purple|green|red|amber|sky|blue|yellow|pink|orange|gray}-{1..4}
                       -1 = tint  -2 = soft / border  -3 = icon / chart  -4 = accent

ring-app-purple-2       focus halo (paired with ring-offset-4)
shadow-[var(--app-shadow-elevated)]   the two-shadow stack
rounded-app-{1..6}      0.125rem → 1rem radius scale
```

## Utilities

| Class               | What it does                                                                      |
| ------------------- | --------------------------------------------------------------------------------- |
| `.app`              | Subtree opt-in: white bg, fg-3 text, -0.02em tracking, cursor:default.            |
| `.app-elevated`     | Two-shadow stack (1px drop + 0-blur hairline). Bumps on hover.                    |
| `.app-frost-header` | Masked backdrop-blur for fixed headers — fades to no-blur at the very top.        |
| `.app-press`        | `active:scale(0.99)` press microinteraction. Used on every interactive primitive. |

## Preview

Open `/preview/app` to see every primitive on one page. The dashboard pattern (header + KPI strip + chart placeholder + 2×2 card grid + dock) is replicated to match the visitors.now screenshots in the archive.

## Not yet built

- A11y tabs primitive matching the "Top | Entered | Exited" pattern in card headers.
- A `AppList` row primitive for the People page list-with-avatar-and-source layout.
- Empty-state primitive (small ringed icon + caption).
- Dark variant of every token (postponed by design — see scope decision on the original branch).
