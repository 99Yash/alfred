---
id: scripts-call-live-owner
section: Backend
status: stays-review
rung: none
---

# Make a script, dry run or backfill call the live owner.

Add the missing verb to the owner. Do not copy its logic.

Why: a copy skips the gates of the owner. Example: `setIfUnset`, #1347.

## Bad

```ts
await tx
  .insert(userPreferences)
  .values({ userId: u.id, key: "timezone", value: tz, source: { kind: "user" } })
  .onConflictDoNothing({ target: [userPreferences.userId, userPreferences.key] });
```

The copy skips the schema parse of the owner.

## Good

```ts
// The owner validates the value and keeps a value that the user chose.
await settings({ userId: u.id, exec: tx }).setIfUnset("timezone", tz);
```

## Mechanism

A copy compiles. `no-restricted-imports` already fences each `internal` door.

## Hits

- #1347 packages/http/src/onboarding.ts: a direct `user_preferences` insert copied the owner; the owner now has `setIfUnset`.
