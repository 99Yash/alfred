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

## Before the window

This procedure uses
[`railway connect --tunnel-only`](https://docs.railway.com/cli/connect) to reach
the Postgres service over SSH. It does not need a public database proxy or a
running `server` replica.

Run every local command from a clean checkout of the exact revision that you
will deploy. Confirm that the CLI points at Alfred production before you stop
anything. The upgraded CLI must list `--tunnel-only` under
`railway connect --help`.

```bash
railway upgrade
railway status --json
railway connect --help
git status --short --branch
git rev-parse HEAD
```

Railway SSH requires a registered local key. List the keys first:

```bash
railway ssh keys list
```

If this machine has no registered key, create and register a dedicated one
before the maintenance window:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/railway_alfred
railway ssh keys add \
  --key ~/.ssh/railway_alfred.pub \
  --name alfred-maintenance
```

Rehearse the Step 5 tunnel while `server` is still running, then stop it with
Ctrl-C. Do not begin the maintenance window until the tunnel opens.

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

Create a native backup of the Railway `Postgres` service from its **Backups**
tab. Wait until Railway reports that the backup completed. Do not assume that
the Node server image contains `pg_dump`.

Take the backup **before** the conversion. Step 8 explains why a restore is
your only rollback.

## Step 4. Stop every writer

Scale the `server` service to zero replicas. That one process holds the HTTP
listener and every worker (agent, ingestion, memory, briefing), so stopping it
stops all writers.

Confirm in Railway that `server` has zero active replicas before you continue.
Do not restart the old release after this point: once Step 6 converts a row, the
old release would treat its envelope as a plaintext token.

## Step 5. Report before you convert

Keep the `server` service at zero. In terminal A, open a tunnel directly to the
database service:

```bash
railway connect Postgres \
  --environment production \
  --tunnel-only \
  --port 15432
```

The command prints a connection URL and keeps the tunnel open. In terminal B,
read that URL into an environment variable without adding it to shell history:

```bash
printf 'Tunnel DATABASE_URL: '
IFS= read -rs TUNNEL_DATABASE_URL
printf '\n'
export TUNNEL_DATABASE_URL
```

Then run the check from the clean checkout:

```bash
railway run \
  --service server \
  --environment production \
  --no-local \
  sh -c 'DATABASE_URL="$TUNNEL_DATABASE_URL" pnpm db:encrypt-credentials:check'
```

It writes nothing and prints two counts: plaintext fields, and fields that are
envelope-shaped but do not open with the configured key. Before the first
conversion the plaintext count is non-zero and the unopenable count is zero. The
command exits `1` on either, so it can never pass silently inside a pipeline.

The check *opens* every envelope it counts rather than pattern-matching its
shape. Shape alone cannot tell a row this key can read from a row sealed under a
different key, which is exactly the mistake the rotation procedure below would
otherwise hide.

`railway run` executes the command on the local checkout. It supplies the
production `server` variables, including `OAUTH_CREDENTIAL_KEK`; the inner
`DATABASE_URL` assignment replaces Railway's private hostname with the local
SSH-tunnel URL. The command does not attach to or start a `server` replica.

## Step 6. Convert

```bash
railway run \
  --service server \
  --environment production \
  --no-local \
  sh -c 'DATABASE_URL="$TUNNEL_DATABASE_URL" pnpm db:encrypt-credentials'
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

## Step 7. Deploy, verify, then start

Keep `server` at zero replicas. Merge and deploy the exact revision whose local
checkout ran Step 6. Wait for Railway to build the new server image, run its
pre-deploy command, and show the expected Git commit on the deployment. The old
release must not be started again.

With the database tunnel still open, verify the converted table:

```bash
railway run \
  --service server \
  --environment production \
  --no-local \
  sh -c 'DATABASE_URL="$TUNNEL_DATABASE_URL" pnpm db:encrypt-credentials:check'
# must print 0 / 0 and exit 0
```

Only after the deployment revision and the `0 / 0` result both match, scale
`server` to one replica. `startRuntime` runs the same check before the listener
binds or any worker leases a job, so a missed row fails the boot rather than
serving broken credential reads.

After the first successful boot, confirm one real read end to end: open the app,
load the inbox, and check that a Gmail-backed view renders. That proves the
`integration_credentials` path. Signing out and back in proves the `account`
path.

Close terminal A and remove the copied connection URL from terminal B:

```bash
unset TUNNEL_DATABASE_URL
```

## Step 8. Rollback

**There is no reverse command, and "remove the key" is not a rollback.**
`OAUTH_CREDENTIAL_KEK` is required in every environment (Step 2), so a process
without it stops at env validation. The boot gate is the second half of the same
rule: it refuses to start on a plaintext row *or* on a row it cannot open. So
every rollback below ends in a table the configured key can read — there is no
path back to a plaintext table that also boots.

Both procedures assume you are still inside the maintenance window, with the
`server` service at zero replicas.

### You need the pre-conversion state back

Keep `server` at zero replicas. Restore the Step 3 backup from the Railway
`Postgres` service, **keep the key installed**, reopen the Step 5 tunnel, and
convert again:

```bash
railway run \
  --service server \
  --environment production \
  --no-local \
  sh -c 'DATABASE_URL="$TUNNEL_DATABASE_URL" pnpm db:encrypt-credentials'
railway run \
  --service server \
  --environment production \
  --no-local \
  sh -c 'DATABASE_URL="$TUNNEL_DATABASE_URL" pnpm db:encrypt-credentials:check'
```

Then start `server`. The restore loses every database write made after the
backup, not only credential writes. Keep the service stopped until you accept
that rollback boundary.

### You lost the key

Every sealed token is unrecoverable, and the gate will not let the process boot
to a state where a user could reconnect — the rows are envelope-shaped, so they
count as unopenable rather than as plaintext. Clear the capability columns first,
then boot, then reconnect. With `server` still at zero replicas, open the
Postgres shell directly:

```bash
railway connect Postgres --environment production
```

Run:

```sql
-- Better Auth identities: keep the row. It also holds the password hash, and
-- deleting it would delete the sign-in itself. Only the three capability
-- columns go, and all three are nullable.
update "account"
   set access_token = null,
       refresh_token = null,
       id_token = null;

-- Integration credentials: access_token is NOT NULL, so the row goes with it.
-- Whatever the row carried in `metadata` — Gmail watch channel ids, for
-- instance — goes too, and the reconnect re-establishes it.
delete from integration_credentials;
```

Install a new key (Step 1 and Step 2), confirm
the Step 5 tunnel check prints `0 / 0`, and start `server`. Then sign in again
and reconnect each integration from the app; both flows mint fresh tokens, which
are sealed under the new key on the way in. Deleting
`integration_credentials` also cascades its `ingestion_state` rows, so the next
sync rebuilds those cursors. Threads, triage, todos, and memory are untouched.

The same two statements are the escape hatch for a stuck `unopenable_remaining`
boot in general: they are the cheap way out at single-user scale, and they cost a
reconnect rather than a rewrap.

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
   key and needs no rewrap at all. Step 8's two statements are how you clear the
   old envelopes so the gate lets the process boot far enough to reconnect.
4. Swap `OAUTH_CREDENTIAL_KEK`, verify through the Step 5 database connection with
   `db:encrypt-credentials:check`, restart. That check catches a missed rewrap:
   it opens every envelope, so a row still sealed under the old key is reported
   as an unopenable field and exits `1`. The boot gate refuses the same table,
   so a missed row cannot reach traffic.
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
