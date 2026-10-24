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
| `AppField`      | Field wrapper: label + control + helper/error, with `AppFieldError` exported for custom layouts.    |
| `AppModal`      | Responsive overlay: a centered themed dialog at 640px and up, a drag-to-dismiss bottom sheet below. |

## Tokens

All app tokens use the `app-` prefix to avoid colliding with dimension tokens:

```
bg-app-bg-{1..4}        backgrounds (1 = white, 4 = heaviest neutral fill)
bg-app-bg-a{1..4}       black alphas (0.03, 0.05, 0.08, 0.12)
text-app-fg-{1..4}      foreground (1 = disabled, 4 = brand ink #181925)
text-app-fg-a{1..4}     alpha variants

bg-app-{purple|green|red|amber|sky|blue|yellow|pink|orange|gray}-{1..4}
                       -1 = tint  -2 = soft / border  -3 = icon / chart  -4 = text / solid fill

--app-accent-ring       shared one-pixel focus stroke
shadow-[var(--app-shadow-elevated)]   the two-shadow stack
```

### Color

The `raw-palette-color` gate in `scripts/consolidation-rules.mjs` rejects a raw Tailwind hue or gray (`text-rose-600`) and a white-alpha step (`text-white/70`) in app code. Use the `app-*` tokens:

| Need                                     | Class                                                     |
| ---------------------------------------- | --------------------------------------------------------- |
| Status text: error, warning, success     | `text-app-red-4`, `text-app-amber-4`, `text-app-green-4`  |
| Status box                               | `bg-app-red-1` + `border-app-red-2` + `text-app-red-4`    |
| Ink on a solid `-4` fill (badge, button) | `text-app-bg-1`                                           |
| Fixed dark surface (video, lightbox)     | `app-media` on its root, then the tokens below            |
| White-alpha ink inside `app-media`       | `text-app-fg-a{1..4}` (30, 50, 70, 92%)                   |
| White-alpha fill or hairline             | `bg-app-bg-a{1..4}`, `ring-app-bg-a{1..4}` (4, 6, 9, 14%) |

Every light `-4` hue meets WCAG AA (4.5:1) as text on white and on its own `-1` tint. Purple is the one exception: `-4` is the brand accent (`--app-accent-from`), which meets AA on white but only 4:1 on its tint. In dark mode `-4` is a light pastel, so white ink on a `-4` fill fails there: use `text-app-bg-1`, which flips with the theme.

`.app-media` gives its subtree the dark token values and no background. Put it on a surface that is dark in both themes, such as the rail over the weather video. A portal leaves the scope, so a menu that opens from inside it uses the normal themed tokens.

Solid `white` and `black`, and `black/N` scrims, stay legal. The landing page, the legal pages, the styleguide, and `ui/legacy` are exempt.

### Radius

Radius comes from what the element is, not from how round it should look. The tiers live in `index.css` `@theme`, and the `raw-radius-class` gate in `scripts/consolidation-rules.mjs` rejects any other radius class in app code.

| Class                | Size | Use it for                                                          |
| -------------------- | ---- | ------------------------------------------------------------------- |
| `rounded-control-xs` | 6px  | Elements 20px tall or smaller: kbd, checkbox, tag, skeleton bar.    |
| `rounded-control-sm` | 8px  | 24-28px controls: `AppButton size="sm"`, small icon buttons.        |
| `rounded-control`    | 14px | 32-40px controls: buttons, nav and thread rows, inputs, menu items. |
| `rounded-surface`    | 18px | Cards, banners, menus, popovers, toasts, message bubbles.           |
| `rounded-panel`      | 20px | App shell, sidebar, rail, composer, dialogs.                        |
| `rounded-full`       | pill | Chips, badges, avatars, dots.                                       |

A container is its inner tier plus its padding: a `rounded-surface` menu with `p-1` holds `rounded-control` items. `cn()` knows these names, so a `className` override replaces the radius instead of adding a second one.

## Utilities

| Class               | What it does                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `.app`              | Subtree opt-in: white bg, fg-3 text, -0.02em tracking, cursor:default.                                                 |
| `.app-elevated`     | Two-shadow stack (1px drop + 0-blur hairline). Bumps on hover.                                                         |
| `.app-frost-header` | Masked backdrop-blur for fixed headers — fades to no-blur at the very top.                                             |
| `.app-focus`        | One-pixel focus stroke, placed 2px outside small controls.                                                             |
| `.app-focus-inset`  | One-pixel focus stroke inside fields and large surfaces.                                                               |
| `.app-focus-within` | The inset stroke for a composite surface when a child has keyboard focus.                                              |
| `.app-press`        | `scale: 0.96` press microinteraction (the CSS `scale` property, not `transform`). Used on every interactive primitive. |

## Form values

`omitBlankStringFields(values)` (in `./form-values.ts`) trims each string and drops
the keys that trim to nothing, so an untouched optional field is absent from the
body rather than `""`. Spread only the optional fields through it and keep the
required ones explicit:

```tsx
const body: McpAddServerBody = {
  endpointUrl: value.endpointUrl.trim(),
  ...omitBlankStringFields({ label: value.label }),
};
```

## Forms

`useAppForm` (from `./form.ts`) is `@tanstack/react-form`'s `useForm` with the app
field components registered. Render a field through `form.AppField` and the
component owns the input wiring and the error slot:

```tsx
const form = useAppForm({ defaultValues, onSubmit });

<form.AppField name="endpointUrl" validators={{ onBlur: urlSchema }}>
  {(field) => <field.TextField label="Server URL" placeholder="https://…" />}
</form.AppField>;
```

`field.TextField` and `field.TextAreaField` are registered today. To add a
control, write it in `form-fields.tsx`, register it in `form.ts`, and every form
can use it.

## Preview

Open `/preview/app` to see every primitive on one page. The dashboard pattern (header + KPI strip + chart placeholder + 2×2 card grid + dock) is replicated to match the visitors.now screenshots in the archive.

## Not yet built

- A11y tabs primitive matching the "Top | Entered | Exited" pattern in card headers.
- A `AppList` row primitive for the People page list-with-avatar-and-source layout.
- Empty-state primitive (small ringed icon + caption).
- Dark variant of every token (postponed by design — see scope decision on the original branch).
