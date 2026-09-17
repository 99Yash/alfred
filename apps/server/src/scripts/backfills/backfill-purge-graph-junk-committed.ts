/**
 * COMMITTED cleanup of the legacy user-model graph (#1108) — the existing prod
 * damage behind the two bars this PR adds to the live writer.
 *
 * Measured on prod 2026-09-16: 23 entities, 12 relations, every relation a
 * `works_at` pointing from a mail sender to that sender's own mail domain, and
 * three non-people (a GitHub advisory id, a CI workflow name, a retailer) filed
 * as `person`. The writer no longer produces either shape. This script removes
 * what it already produced.
 *
 * TWO actions, both scoped by a predicate rather than by a table sweep:
 *
 *   A. EDGES. Delete an `entity_relations` row whose `relation` is `works_at`
 *      AND whose `from` entity holds an email alias whose domain equals the
 *      `to` entity's canonical name. That is "the edge restates the address"
 *      stated in code, so a future GROUNDED `works_at` survives this script.
 *   B. KINDS. Re-run `classifyContactKind` — the SAME function the live writer
 *      uses, so "what is a person" has one definition, per the #493 precedent —
 *      over every `person` row and UPDATE the kind in place when it disagrees.
 *      In place, so the row id, its aliases and its correspondence aggregate
 *      all survive: ADR-0067 types a non-human node, it never drops it.
 *
 * `entities` is unique on `(user_id, kind, canonical_name)`, so a re-kind can
 * collide with a row already at the target coordinate. Such a row is REPORTED
 * and left alone — this script never merges two contacts.
 *
 * Bundled by tsdown (`noExternal: @alfred/*`, registered in `tsdown.config.ts`)
 * so it runs on prod with plain `node dist/...`.
 *
 * Dry by default — classifies and prints what it WOULD do, writes nothing.
 * `--commit` applies and REQUIRES `--emails=...` explicitly so a prod shell typo
 * cannot mutate the default account. A DRY run with no `--emails` surveys ALL
 * users (read-only) so the operator can see the full picture first. Idempotent:
 * a deleted edge cannot re-match, and a re-kinded row already agrees with the
 * classifier, so a second run reports zero.
 *
 *   # preview EVERY account (writes nothing):
 *   node dist/scripts/backfills/backfill-purge-graph-junk-committed.js
 *   # preview one account (writes nothing):
 *   node dist/scripts/backfills/backfill-purge-graph-junk-committed.js --emails=a@x.com
 *   # commit:
 *   node dist/scripts/backfills/backfill-purge-graph-junk-committed.js --emails=a@x.com --commit
 */
import {
  classifyContactKind,
  parsePersonEntityMetadata,
} from "@alfred/assistant/knowledge/internal";
import { isNonEmptyString, parseEmailAddress, toMessage } from "@alfred/contracts";
import { db, warmPool } from "@alfred/db";
import { entities, entityRelations, user as userTable } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";
import { closeScriptResources } from "../script-runtime";

const COMMIT = process.argv.includes("--commit");

/** Cap on how many per-row samples to print in the report (counts are exact). */
const SAMPLE_LIMIT = 50;

/** The relation the ungrounded mint wrote. Nothing else ever reached this table. */
const ADDRESS_DERIVED_RELATION = "works_at";

function parseTargetEmails(): string[] | null {
  const flag = process.argv.find((arg) => arg.startsWith("--emails="));

  if (COMMIT && !flag) {
    throw new Error("--emails=a@x.com must be set explicitly when using --commit");
  }

  // No flag in DRY mode → survey ALL users (read-only).
  if (!flag) return null;

  return flag
    .slice("--emails=".length)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const TARGET_EMAILS = parseTargetEmails();

/** `aliases` is jsonb — persisted data, so read it as `unknown` and keep only strings. */
function readAliases(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter(isNonEmptyString) : [];
}

/** The domain of the first email alias on a contact row, lowercased. */
function aliasDomains(raw: unknown): Set<string> {
  const domains = new Set<string>();

  for (const alias of readAliases(raw)) {
    const address = parseEmailAddress(alias);
    const at = address ? address.lastIndexOf("@") : -1;

    if (address && at > 0) domains.add(address.slice(at + 1));
  }

  return domains;
}

/** The contact's primary address: the metadata bag first, then any email alias. */
function contactAddress(metadata: unknown, aliasesRaw: unknown): string | null {
  const stored = parsePersonEntityMetadata(metadata).primaryAddress;
  const fromMetadata = parseEmailAddress(stored ?? null);

  if (fromMetadata) return fromMetadata;

  for (const alias of readAliases(aliasesRaw)) {
    const address = parseEmailAddress(alias);

    if (address) return address;
  }

  return null;
}

/**
 * A canonical name is a display name OR the raw address. Reveal the domain — the
 * signal an operator reads this report for — without the full local part.
 */
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

  // Both endpoints in ONE read, keyed by id — Drizzle cannot join the same table
  // object twice without an alias, and the endpoint count here is tiny.
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

  const demotions: Array<{ id: string; canonicalName: string; kind: string }> = [];
  let unclassifiable = 0;

  for (const row of rows) {
    const address = contactAddress(row.metadata, row.aliases);

    if (!address) {
      unclassifiable += 1;
      continue;
    }

    // The SAME input the live writer classifies: the stored canonical name.
    // Neither side re-derives a display name, so the script and the next
    // capture run cannot disagree about this row.
    const kind = classifyContactKind({ address, canonicalName: row.canonicalName });

    if (kind !== "person") demotions.push({ id: row.id, canonicalName: row.canonicalName, kind });
  }

  console.log(
    `  person rows: ${rows.length} | re-kind ${demotions.length} | keep ${rows.length - demotions.length - unclassifiable} | no address ${unclassifiable}`,
  );

  for (const d of demotions.slice(0, SAMPLE_LIMIT)) {
    console.log(`    RE-KIND person → ${d.kind}: ${maskName(d.canonicalName)}`);
  }

  if (demotions.length > SAMPLE_LIMIT) {
    console.log(`    …and ${demotions.length - SAMPLE_LIMIT} more`);
  }

  if (!COMMIT) return;

  let updated = 0;
  let blocked = 0;

  for (const d of demotions) {
    // `(user_id, kind, canonical_name)` is unique. A row already sitting at the
    // target coordinate is a different contact, so leave both alone and say so.
    const [clash] = await db()
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          eq(entities.userId, userId),
          eq(entities.kind, d.kind),
          eq(entities.canonicalName, d.canonicalName),
        ),
      )
      .limit(1);

    if (clash) {
      blocked += 1;
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
    // Log only the message — a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources();
  });
