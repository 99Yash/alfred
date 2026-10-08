/**
 * Clean the legacy user-model graph (#1108). The live writer no longer makes these shapes.
 *
 *   A. Delete a `works_at` edge when the `from` entity has an email alias at the
 *      domain the `to` entity names. A grounded `works_at` survives.
 *   B. Re-kind each `person` row through `previewStoredContactKinds`, the same bar
 *      the live writer uses. Update in place, so the id and aliases survive (ADR-0067).
 *
 * The bar reads `metadata.listEvidence` (#1198), which only the team-graph writer stamps.
 * Run `backfill-team-graph-committed.js --commit` first.
 * A re-kind that hits the `(user_id, kind, canonical_name)` unique key is reported, never merged.
 *
 * Dry by default. A dry run without `--emails` surveys all users. `--commit` requires
 * `--emails=...`. Idempotent.
 *
 *   # preview every account (writes nothing):
 *   node dist/scripts/backfills/backfill-purge-graph-junk-committed.js
 *   # preview one account (writes nothing):
 *   node dist/scripts/backfills/backfill-purge-graph-junk-committed.js --emails=a@x.com
 *   # commit:
 *   node dist/scripts/backfills/backfill-purge-graph-junk-committed.js --emails=a@x.com --commit
 */
import {
  previewStoredContactKinds,
  reKindWouldCollide,
  type ContactKind,
} from "@alfred/assistant/knowledge/internal";
import { isNonEmptyString, parseEmailAddress, toMessage } from "@alfred/contracts";
import { db, warmPool } from "@alfred/db";
import { entities, entityRelations, user as userTable } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";
import { closeScriptResources } from "../script-runtime";

const COMMIT = process.argv.includes("--commit");

/** Max sample rows to print. Counts stay exact. */
const SAMPLE_LIMIT = 50;

/** The relation the ungrounded mint wrote. */
const ADDRESS_DERIVED_RELATION = "works_at";

function parseTargetEmails(): string[] | null {
  const flag = process.argv.find((arg) => arg.startsWith("--emails="));

  if (COMMIT && !flag) {
    throw new Error("--emails=a@x.com must be set explicitly when using --commit");
  }

  if (!flag) return null;

  return flag
    .slice("--emails=".length)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const TARGET_EMAILS = parseTargetEmails();

/** `aliases` is jsonb, so keep only strings. */
function readAliases(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter(isNonEmptyString) : [];
}

/** The domains of every email alias on a contact row. */
function aliasDomains(raw: unknown): Set<string> {
  const domains = new Set<string>();

  for (const alias of readAliases(raw)) {
    const address = parseEmailAddress(alias);
    const at = address ? address.lastIndexOf("@") : -1;

    if (address && at > 0) domains.add(address.slice(at + 1));
  }

  return domains;
}

/** Show the domain of an address-like name, not its local part. */
function maskName(canonicalName: string): string {
  const at = canonicalName.lastIndexOf("@");

  if (at <= 0) return canonicalName;

  return `${canonicalName.slice(0, 1)}…@${canonicalName.slice(at + 1)}`;
}

async function purgeAddressDerivedEdges(userId: string): Promise<void> {
  const rows = await db()
    .select({
      id: entityRelations.id,
      fromEntityId: entityRelations.fromEntityId,
      toEntityId: entityRelations.toEntityId,
    })
    .from(entityRelations)
    .where(
      and(
        eq(entityRelations.userId, userId),
        eq(entityRelations.relation, ADDRESS_DERIVED_RELATION),
      ),
    );

  if (rows.length === 0) {
    console.log(`  ${ADDRESS_DERIVED_RELATION} edges: 0`);

    return;
  }

  // One read for both endpoints. A self-join needs a Drizzle alias.
  const endpointIds = [...new Set(rows.flatMap((r) => [r.fromEntityId, r.toEntityId]))];

  const endpoints = await db()
    .select({ id: entities.id, canonicalName: entities.canonicalName, aliases: entities.aliases })
    .from(entities)
    .where(and(eq(entities.userId, userId), inArray(entities.id, endpointIds)));

  const byId = new Map(endpoints.map((e) => [e.id, e]));

  const addressDerived = rows.filter((row) => {
    const from = byId.get(row.fromEntityId);
    const to = byId.get(row.toEntityId);

    if (!from || !to) return false;

    return aliasDomains(from.aliases).has(to.canonicalName.trim().toLowerCase());
  });

  const kept = rows.length - addressDerived.length;

  console.log(
    `  ${ADDRESS_DERIVED_RELATION} edges: ${rows.length} | address-derived ${addressDerived.length} | keep ${kept}`,
  );

  for (const row of addressDerived.slice(0, SAMPLE_LIMIT)) {
    const from = byId.get(row.fromEntityId);
    const to = byId.get(row.toEntityId);
    console.log(
      `    DELETE ${maskName(from?.canonicalName ?? row.fromEntityId)} —${ADDRESS_DERIVED_RELATION}→ ${to?.canonicalName ?? row.toEntityId}`,
    );
  }

  if (addressDerived.length > SAMPLE_LIMIT) {
    console.log(`    …and ${addressDerived.length - SAMPLE_LIMIT} more`);
  }

  if (!COMMIT || addressDerived.length === 0) return;

  await db()
    .delete(entityRelations)
    .where(
      and(
        eq(entityRelations.userId, userId),
        inArray(
          entityRelations.id,
          addressDerived.map((row) => row.id),
        ),
      ),
    );

  console.log(`  COMMITTED — deleted ${addressDerived.length} edge(s).`);
}

async function rekindContacts(userId: string): Promise<void> {
  const rows = await db()
    .select({
      id: entities.id,
      canonicalName: entities.canonicalName,
      aliases: entities.aliases,
      metadata: entities.metadata,
    })
    .from(entities)
    .where(and(eq(entities.userId, userId), eq(entities.kind, "person")));

  const demotions: Array<{ id: string; canonicalName: string; kind: ContactKind }> = [];

  // Each row classifies its own stored name, keyed by row id.
  const { kinds, unclassifiable: unanswered } = previewStoredContactKinds(rows);
  const unclassifiable = unanswered.length;

  for (const row of rows) {
    // Missing only for an `unclassifiable` row. Leave it alone.
    const kind = kinds.get(row.id);

    if (kind !== undefined && kind !== "person") {
      demotions.push({ id: row.id, canonicalName: row.canonicalName, kind });
    }
  }

  // A row already at the target key is a different contact. Never merge.
  // Counted before the commit check, so dry and commit report the same number.
  const blockedIds = new Set<string>();

  for (const d of demotions) {
    if (
      await reKindWouldCollide({
        userId,
        from: "person",
        kind: d.kind,
        canonicalName: d.canonicalName,
      })
    ) {
      blockedIds.add(d.id);
    }
  }

  const blocked = blockedIds.size;

  console.log(
    `  person rows: ${rows.length} | re-kind ${demotions.length} (blocked ${blocked}) | keep ${rows.length - demotions.length - unclassifiable} | no address ${unclassifiable}`,
  );

  for (const d of demotions.slice(0, SAMPLE_LIMIT)) {
    console.log(`    RE-KIND person → ${d.kind}: ${maskName(d.canonicalName)}`);
  }

  if (demotions.length > SAMPLE_LIMIT) {
    console.log(`    …and ${demotions.length - SAMPLE_LIMIT} more`);
  }

  if (!COMMIT) return;

  let updated = 0;

  for (const d of demotions) {
    if (blockedIds.has(d.id)) {
      console.log(`    ! name clash, left as person: ${maskName(d.canonicalName)}`);
      continue;
    }

    await db().update(entities).set({ kind: d.kind }).where(eq(entities.id, d.id));
    updated += 1;
  }

  console.log(`  COMMITTED — re-kinded ${updated}/${demotions.length} (blocked ${blocked}).`);
}

async function processUser(u: { userId: string; email: string }): Promise<void> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);
  await purgeAddressDerivedEdges(u.userId);
  await rekindContacts(u.userId);

  if (!COMMIT) console.log(`\n  DRY — nothing written. Re-run with --emails=… --commit to apply.`);
}

async function main() {
  await warmPool();
  console.log(
    `# Purge user-model graph junk (#1108) — mode=${COMMIT ? "COMMIT" : "DRY"} | ` +
      `targets=${TARGET_EMAILS ? TARGET_EMAILS.join(", ") : "ALL USERS"}`,
  );

  const users = await (TARGET_EMAILS
    ? db()
        .select({ userId: userTable.id, email: userTable.email })
        .from(userTable)
        .where(inArray(userTable.email, TARGET_EMAILS))
    : db().select({ userId: userTable.id, email: userTable.email }).from(userTable));

  if (TARGET_EMAILS) {
    const found = new Set(users.map((u) => u.email));
    const missing = TARGET_EMAILS.filter((e) => !found.has(e));

    if (missing.length > 0) {
      const message = `no user row for target email(s): ${missing.join(", ")}`;

      if (COMMIT) throw new Error(message);
      console.log(`! ${message} — skipping`);
    }
  }

  for (const u of users) await processUser(u);

  console.log("\n# done");
}

main()
  .catch((e) => {
    // Message only: a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources();
  });
