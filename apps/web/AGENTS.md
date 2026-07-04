# Alfred Web Guidance

## Boundaries

- Browser runtime may import `@alfred/contracts`, `@alfred/sync`, and `@alfred/schemas`. Do not import `@alfred/api`, `@alfred/db`, `@alfred/env`, `@alfred/auth`, or `@alfred/ai` into code that can land in the web bundle.
- Run `pnpm check:web-boundaries` after changing imports near `apps/web`.

## Unknown Data

- Treat URL search params, `localStorage`, SSE messages, JSON previews, and provider metadata as untrusted.
- Use `safeJsonParse` for raw JSON strings. Use `isRecord`, `toRecord`, `getPath`, `getStringPath`, and Zod schemas before reading fields.
- Do not create local `asRecord` helpers unless they wrap the shared contracts guard. Prefer importing the shared helper directly when possible.

## React

- Do not sync props into state with `useEffect` just to reset derived UI. Key the state by the prop or derive during render so the UI does not show a stale intermediate frame.
- In list renders, put `key` directly on the JSX element and do not use `{...spread}` on the same element if the spread could overwrite `key`.
- For React Doctor findings, fix high-confidence behavior issues. Treat Tailwind class-order/deprecated-class warnings as migration-scale unless the touched component is already being restyled.
