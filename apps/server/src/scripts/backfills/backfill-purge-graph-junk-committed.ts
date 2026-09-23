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
 *   B. KINDS. Re-kind every `person` row through `previewStoredContactKinds` —
 *      each row classifies its OWN stored `canonicalName` through the SAME
 *      `classifyContactKind` bar the live writer applies (and the dry run
 *      previews through `previewContactKinds`), so "what is a person" has one
 *      definition, per the #493 precedent — and UPDATE the kind in place when
 *      it disagrees. In place, so the row id, its aliases and its
 *      correspondence aggregate all survive: ADR-0067 types a non-human node,
 *      it never drops it.
 *
 * `entities` is unique on `(user_id, kind, canonical_name)`, so a re-kind can
 * collide with a row already at the target coordinate. Such a row is REPORTED
 * and left alone — this script never merges two contacts. The predicate is
 * `reKindWouldCollide`, the one the live writer applies, imported through the
 * same door as the preview so the policy has a single home.
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

  const demotions: Array<{ id: string; canonicalName: string; kind: ContactKind }> = [];

  // Each row classifies its OWN stored canonical name — the same input the
  // live writer classifies for that row — through the row-keyed door, which
  // derives each row's own address from its metadata/aliases. A wrapped
  // alias, a metadata-led address, or an alias shared with another row
  // cannot borrow a sibling's name. Keyed by row id: no caller-side key
  // derivation, and a row with no derivable address is listed in the door's
  // `unclassifiable` — the single source of truth below — rather than
  // defaulting toward a write.
  const { kinds, unclassifiable: unanswered } = previewStoredContactKinds(rows);
  const unclassifiable = unanswered.length;

  for (const row of rows) {
    // Absent from `kinds` only when the row yields no address (no metadata
    // address and no email alias — exactly the door's `unclassifiable` list):
    // leave it alone rather than defaulting toward a write.
    const kind = kinds.get(row.id);

    if (kind !== undefined && kind !== "person") {
      demotions.push({ id: row.id, canonicalName: row.canonicalName, kind });
    }
  }

  // The SAME predicate the live writer applies, through the same door as the
  // classifier: a row already at the target coordinate is a different
  // contact, so leave both alone and say so. Never merge. Counted BEFORE the
  // commit check — read-only SELECTs, so dry stays dry — and the dry report
  // prints the same `re-kind N (blocked B)` the commit prints.
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
    // Log only the message — a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources();
  });
