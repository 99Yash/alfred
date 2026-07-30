# Runbook: OAuth credential vault rollout

> Issue [#453](https://github.com/99Yash/alfred/issues/453). Amends
> [ADR-0038](../decisions/ADR-0038-content-at-rest-posture-vendor-crypto-only-no.md).

This procedure converts the OAuth token columns from plaintext to sealed
envelopes. It is a **maintenance-window** operation. Read the whole file before
you start.

## What changes

Five columns move from a plaintext token to an AES-256-GCM envelope:

| Table | Columns |
| --- | --- |
| `account` | `access_token`, `refresh_token`, `id_token` |
| `integration_credentials` | `access_token`, `refresh_token` |

The columns stay `text`, so **no migration is generated**. The change is in the
value, not the schema.

## Why the window is not optional

An old process reads those columns as plaintext. If one is running during the
conversion, two failures follow:

1. It reads an envelope and sends it to Google or GitHub as a bearer token.
2. It refreshes a token and writes the new one back **in plaintext**, after the
   verification already reported zero.

The second failure is the dangerous one, because it leaves the system looking
converted. Stop every writer first.

## Step 1. Generate the key

```bash
openssl rand -base64 32
```

Keep it out of every tracked file, every chat, and every commit. This key and a
database dump together are the plaintext tokens; separately, neither is.

## Step 2. Install the key

Set `OAUTH_CREDENTIAL_KEK` on the Railway `server` service, and in your local
`apps/server/.env`. The value must decode to exactly 32 bytes; boot rejects
anything else with a named error.

**Every** environment requires the variable, local development included. The
vault also protects Better Auth's `account` token columns, so a process without
the key does not lose only its integrations — it fails every sign-in and every
session check. `serverEnv()` is the single owner of that requirement, so the
failure is one boot error naming the generation command above, not a broken
sign-in an hour later. There is no plaintext fallback.

## Step 3. Back up the database

```bash
railway ssh -s server   # then pg_dump, or take a platform snapshot
```

Take the backup **before** the conversion. Step 8 explains why a restore is your
only rollback.

## Step 4. Stop every writer

Scale the `server` service to zero replicas. That one process holds the HTTP
listener and every worker (agent, ingestion, memory, briefing), so stopping it
stops all writers.

Confirm nothing is serving before you continue.

## Step 5. Report before you convert

```bash
pnpm db:encrypt-credentials:check
```

It writes nothing and prints two counts: plaintext fields, and fields that are
envelope-shaped but do not open with the configured key. Before the first
conversion the plaintext count is non-zero and the unopenable count is zero. The
command exits `1` on either, so it can never pass silently inside a pipeline.

The check *opens* every envelope it counts rather than pattern-matching its
shape. Shape alone cannot tell a row this key can read from a row sealed under a
different key, which is exactly the mistake the rotation procedure below would
otherwise hide.

## Step 6. Convert

```bash
pnpm db:encrypt-credentials
```

The whole pass is one transaction, so a malformed row rolls the run back rather
than leaving the table half-converted. It skips rows that already open with the
configured key, so running it twice is safe. It converts plaintext only: a row
sealed under a *different* key aborts the run instead of being skipped as done,
because rewrapping needs both keys.

Expect:

```
  plaintext token fields remaining:     0
  unopenable token fields remaining:    0
  → every persisted OAuth token is sealed and opens with the configured key.
```

## Step 7. Verify, then start

```bash
pnpm db:encrypt-credentials:check   # must print 0 and exit 0
```

Then scale `server` back up. `startRuntime` runs the same check before the
listener binds or any worker leases a job, so a missed row fails the boot rather
than serving broken credential reads.

After the first successful boot, confirm one real read end to end: open the app,
load the inbox, and check that a Gmail-backed view renders. That proves the
`integration_credentials` path. Signing out and back in proves the `account`
path.

## Step 8. Rollback limits

**There is no reverse command.** The rollback is: restore the Step 3 backup and
remove `OAUTH_CREDENTIAL_KEK`. Any credential written after the conversion is
lost by that restore, and the affected integration needs a reconnect.

If you lose the KEK, every sealed token is unrecoverable. Recovery is a
reconnect of every integration and a fresh sign-in — no data other than
credentials is affected.

## Key rotation

Rotation is the same maintenance window, not an online operation.

1. Generate a new key. Do **not** delete the old one yet.
2. Stop every writer.
3. Rewrap: read each row with the old key and write it with the new one.
   **No command does this yet.** `db:encrypt-credentials` converts plaintext; it
   holds one key, so it cannot read the old envelope and write the new one, and
   it aborts rather than pretend. Until the rewrap pass exists, rotation means a
   throwaway script holding both keys — or, at single-user scale, a reconnect of
   every integration plus a fresh sign-in, which mints new tokens under the new
   key and needs no rewrap at all.
4. Swap `OAUTH_CREDENTIAL_KEK`, verify with `db:encrypt-credentials:check`,
   restart. That check catches a missed rewrap: it opens every envelope, so a row
   still sealed under the old key is reported as an unopenable field and exits
   `1`. The boot gate refuses the same table, so a missed row cannot reach
   traffic.
5. Destroy the old key only after a verified boot.

Never reuse a nonce. `seal` draws fresh random nonces per call, so the only way
to break this is to hand-write an envelope. Do not.

## What this defends, honestly

It defends a database artifact that travels without the secret environment: a
leaked row, a read replica, an off-platform backup, a support export.

It does **not** defend code execution on the application server. That attacker
reads `OAUTH_CREDENTIAL_KEK` from the process environment and calls `open`
exactly like Alfred does. A KEK beside the app is a real reduction in blast
radius, not a claim of secrecy from the app itself. Say it that way in any
user-facing copy.
