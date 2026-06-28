/**
 * COMMITTED purge of document-metadata pollution in `user_facts` (issue #331,
 * one-off 2026-06-28).
 *
 * The per-document memory extractor harvested transactional email metadata as
 * durable `user_facts` — AGM/e-voting/dividend/insurance/trip/order/subscription
 * /course/tax fields, plus `company_name` lifted from a job-alert email. With
 * ~885 active document-sourced facts the noise floods `read_user_context`'s
 * recency-ranked top-30 (issue #329) and the boss answers "where do I work?"
 * with garbage ("AirBills"). This script clears the noise so the authoritative
 * identity (`current_company="Oliv AI"`, c=1.0, source=user) is what surfaces.
 *
 * What it does: for the target user's **active** (`proposed`|`confirmed`),
 * **document-sourced** facts, KEEP only keys on the user-identity/preference
 * allow-list and REJECT the rest via the governance path (`rejectFact` →
 * `status='rejected'` + `valid_until=now` + a `rejected_inferences` row, so the
 * same (key,value) is not silently re-extracted). Reversible: un-reject from the
 * memory UI. `relationship:*` graph facts are a separate (P4) concern and are
 * SKIPPED by default (`--include-relationships` to fold them in).
 *
 * The allow-list lives here for now; issue #330 promotes it to a shared
 * `@alfred/contracts` constant that the extractor guard (`isDocumentMetadataKey`)
 * and this script both read.
 *
 * Bundled by tsdown (`noExternal: @alfred/*`) so it runs on prod with plain
 * `node dist/scripts/backfill-purge-document-facts-committed.js` (the prod image
 * has no tsx / loose `@alfred/*` sources).
 *
 * SAFETY: dry by default — classifies and prints what it WOULD reject, writes
 * nothing. Pass `--commit` to apply. Idempotent (already-rejected/non-current
 * rows are inactive and won't re-match). `--commit` requires PURGE_FACTS_EMAILS
 * explicitly so a prod shell typo cannot mutate the default account.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfill-purge-document-facts-committed.js
 *   # commit:
 *   PURGE_FACTS_EMAILS="yashgouravkar@gmail.com" node dist/scripts/backfill-purge-document-facts-committed.js --commit
 *   # other target / also purge relationship:* graph facts:
 *   PURGE_FACTS_EMAILS="a@x.com" node dist/scripts/backfill-purge-document-facts-committed.js --commit --include-relationships
 */
import { closeConnections, closeRedis, rejectFact, warmPool } from "@alfred/api";
import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { user as userTable, userFacts } from "@alfred/db/schemas";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";

/**
 * Genuine durable user-identity / preference keys that may legitimately be
 * extracted from a document. Everything else with `source.kind="document"` is
 * treated as per-email metadata and purged. Conservative by design: when a key
 * is ambiguous (multi-valued contact/org noise like `manager`, `company`,
 * `website`, `user_name`) it is NOT here and gets purged — review the dry run
 * before committing. Promote to `@alfred/contracts` in #330.
 */
const IDENTITY_ALLOW_LIST = new Set<string>([
  // names / identity
  "first_name",
  "last_name",
  "full_name",
  "user_nickname",
  "bio_summary",
  "birthday",
  "birthday_year",
  "personal_website",
  // current role (the authoritative ones are source=user, but keep any
  // document-sourced copies rather than risk dropping a real signal)
  "current_company",
  "current_work",
  "current_role",
  // location (the user's own)
  "current_location",
  "home_city",
  "home_state",
  "home_country",
  "home_street",
  "home_address",
  "home_postal_code",
  "home_zip_code",
  "address",
  "country",
  "timezone",
  "phone_number",
  "home_phone",
  // job-search / work preferences (durable, about the user)
  "work_preference",
  "employment_preference",
  "employment_type",
  "relocation_preference",
  "willing_to_relocate",
  "role_preference",
  "preferred_role_types",
  "preferred_skills",
  "skills",
  "job_search_focus",
  "job_search_status",
  "job_search_preferences",
  "professional_interest",
  "work_experience",
  "work_experience_years",
  "education",
  // the user's own handles
  "github_username",
  "linkedin_username",
  "linkedin_profile_url",
  "chess_com_username",
  "leetcode_rank",
  "reddit_username",
]);

const targetEmailsEnv = process.env.PURGE_FACTS_EMAILS;
const COMMIT = process.argv.includes("--commit");
const INCLUDE_RELATIONSHIPS = process.argv.includes("--include-relationships");

if (COMMIT && !targetEmailsEnv?.trim()) {
  throw new Error("PURGE_FACTS_EMAILS must be set explicitly when using --commit");
}

const TARGET_EMAILS = (targetEmailsEnv ?? "yashgouravkar@gmail.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** A document-sourced fact is graph/relationship data, not identity noise. */
function isRelationshipKey(key: string): boolean {
  return key.startsWith("relationship:") || key.startsWith("stock_holding:");
}

function preview(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 48 ? `${s.slice(0, 47)}…` : s;
}

async function processUser(u: { userId: string; email: string }): Promise<void> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);
  const now = new Date();

  // Active/current facts only. `source` is jsonb → already a parsed object from pg.
  const rows = await db()
    .select({
      id: userFacts.id,
      key: userFacts.key,
      value: userFacts.value,
      confidence: userFacts.confidence,
      status: userFacts.status,
      source: userFacts.source,
    })
    .from(userFacts)
    .where(
      and(
        eq(userFacts.userId, u.userId),
        inArray(userFacts.status, ["proposed", "confirmed"]),
        or(isNull(userFacts.validUntil), gt(userFacts.validUntil, now)),
      ),
    );

  const docRows = rows.filter(
    (r) => (r.source as { kind?: string } | null)?.kind === "document",
  );

  const keep: typeof docRows = [];
  const skipRel: typeof docRows = [];
  const purge: typeof docRows = [];
  for (const r of docRows) {
    if (isRelationshipKey(r.key) && !INCLUDE_RELATIONSHIPS) skipRel.push(r);
    else if (IDENTITY_ALLOW_LIST.has(r.key)) keep.push(r);
    else purge.push(r);
  }

  console.log(
    `  active facts: ${rows.length} total | ${docRows.length} document-sourced ` +
      `→ keep ${keep.length}, purge ${purge.length}, skip-relationship ${skipRel.length}` +
      `${INCLUDE_RELATIONSHIPS ? " (relationships folded into purge)" : ""}`,
  );

  // Distinct purge keys (sorted) so the reviewer sees the shape, not 600 lines.
  const byKey = new Map<string, number>();
  for (const r of purge) byKey.set(r.key, (byKey.get(r.key) ?? 0) + 1);
  console.log(`\n  PURGE — ${byKey.size} distinct keys / ${purge.length} rows:`);
  for (const key of [...byKey.keys()].sort()) {
    const sample = purge.find((r) => r.key === key)!;
    const n = byKey.get(key)!;
    console.log(`    ${key}${n > 1 ? ` ×${n}` : ""} = ${preview(sample.value)}`);
  }

  console.log(`\n  KEEP (allow-listed identity/preference): ${keep.length} rows`);
  for (const r of keep) console.log(`    ${r.key} = ${preview(r.value)} (c=${r.confidence})`);

  if (!COMMIT) {
    console.log(`\n  DRY — nothing written. Re-run with --commit to reject the ${purge.length} rows.`);
    return;
  }

  let rejected = 0;
  for (const r of purge) {
    const res = await rejectFact({
      factId: r.id,
      userId: u.userId,
      reason: { via: "backfill-purge-document-facts", issue: 331, key: r.key },
    });
    if (res) rejected++;
  }
  console.log(`\n  COMMITTED — rejected ${rejected}/${purge.length} document-metadata facts.`);
}

async function main() {
  await warmPool();
  console.log(
    `# Purge document-metadata user_facts — mode=${COMMIT ? "COMMIT" : "DRY"} | ` +
      `relationships=${INCLUDE_RELATIONSHIPS ? "INCLUDED" : "skipped"} | targets=${TARGET_EMAILS.join(", ")}`,
  );

  const users = await db()
    .select({ userId: userTable.id, email: userTable.email })
    .from(userTable)
    .where(inArray(userTable.email, TARGET_EMAILS));

  const found = new Set(users.map((u) => u.email));
  for (const email of TARGET_EMAILS) {
    if (!found.has(email)) console.log(`! no user row for ${email} — skipping`);
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
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });
