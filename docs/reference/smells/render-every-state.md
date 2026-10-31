---
id: render-every-state
section: Frontend
status: stays-review
rung: none
---

# Render the loading, error, empty and populated states.

Why: an async surface without an empty or error branch is not finished. Example: `apps/web/src/routes/-approvals/approvals-page.tsx`.

## Bad

```tsx
const { rows } = useActionStagings();

return rows.map((row) => <ApprovalRow key={row.id} row={row} />);
```

## Good

```tsx
{loading ? (
  <AppCard>Loading approvals…</AppCard>
) : error && rows.length === 0 ? (
  <EmptyState title="Approvals sync did not load" body={error} action={retryButton} />
) : rows.length === 0 ? (
  <EmptyState title="No pending approvals" body="Alfred will pause here…" />
) : (
  rows.map((row) => <ApprovalRow key={row.id} row={row} />)
)}
```

## Mechanism

Behavior, not shape.

A check cannot know which states an async source can reach, or which branch of the JSX shows each state.

## Hits
