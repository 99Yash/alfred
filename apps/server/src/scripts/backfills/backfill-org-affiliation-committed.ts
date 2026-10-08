/**
 * Emit `user_org_affiliation` observations for Google accounts connected before the
 * connect route started emitting them (ADR-0080 §4a, #342). It uses the live
 * `buildOrgAffiliationObservationInput`, with each credential's `createdAt` as the
 * event time, so a re-run or a later re-auth dedups on `evidenceHash`.
 *
 * Bundled for prod. Dry by default. `--commit` requires `--emails=...`. Idempotent.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfills/backfill-org-affiliation-committed.js
 *   # commit:
 *   node dist/scripts/backfills/backfill-org-affiliation-committed.js --emails=yashgouravkar@gmail.com --commit
 */
import {
  buildOrgAffiliationObservationInput,
  recordOrgAffiliationOnConnect,
} from "@alfred/assistant/knowledge";
import { warmPool } from "@alfred/db";
import { closeScriptResources } from "../script-runtime";
import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials, user as userTable } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";

const COMMIT = process.argv.includes("--commit");

const VERBOSE = process.argv.includes("--verbose");

function maskEmail(email: string | null | undefined): string {
  if (!email) return "(no email)";

  if (VERBOSE) return email;
  const at = email.indexOf("@");

  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visibleLocal = local.length <= 2 ? `${local[0] ?? "*"}*` : `${local.slice(0, 2)}***`;
  const [domainHead, ...domainRest] = domain.split(".");
  const safeDomainHead = domainHead ?? "";

  const visibleDomain =
    domainRest.length > 0
      ? `${safeDomainHead.slice(0, 1)}***.${domainRest.join(".")}`
      : `${domain.slice(0, 1)}***`;

  return `${visibleLocal}@${visibleDomain}`;
}

function maskId(id: string): string {
  if (VERBOSE) return id;

  return id.length <= 8 ? "***" : `${id.slice(0, 6)}...${id.slice(-4)}`;
}

function parseTargetEmails(): string[] {
  const flag = process.argv.find((arg) => arg.startsWith("--emails="));

  if (COMMIT && !flag) {
    throw new Error("--emails=a@x.com must be set explicitly when using --commit");
  }

  const raw = flag ? flag.slice("--emails=".length) : "yashgouravkar@gmail.com";

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const TARGET_EMAILS = parseTargetEmails();

if (COMMIT && TARGET_EMAILS.length === 0) {
  throw new Error("--emails must include at least one email when using --commit");
}

async function processUser(u: { userId: string; email: string }): Promise<void> {
  console.log(`\n=== ${maskEmail(u.email)} (user=${maskId(u.userId)}) ===`);

  // Include `needs_reauth`: the affiliation comes from the domain, not the token.
  const creds = await db()
    .select({
      id: integrationCredentials.id,
      accountId: integrationCredentials.accountId,
      accountEmail: integrationCredentials.accountLabel,
      metadata: integrationCredentials.metadata,
      createdAt: integrationCredentials.createdAt,
      status: integrationCredentials.status,
    })
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.userId, u.userId),
        eq(integrationCredentials.provider, "google"),
      ),
    );

  console.log(`  google credentials: ${creds.length}`);

  let emitted = 0;
  let deduped = 0;
  let skipped = 0;

  for (const cred of creds) {
    const built = buildOrgAffiliationObservationInput(
      {
        userId: u.userId,
        accountId: cred.accountId,
        accountEmail: cred.accountEmail,
        metadata: cred.metadata,
      },
      { status: "connected", occurredAt: cred.createdAt },
    );

    if (!built.ok) {
      skipped++;
      console.log(
        `    SKIP ${cred.accountEmail ? maskEmail(cred.accountEmail) : maskId(cred.id)} ` +
          `(${cred.status}) — ${built.reason}`,
      );
      continue;
    }

    const { domainClass } = built;
    const groundsEmployer = domainClass === "corporate_domain";
    console.log(
      `    ${maskEmail(cred.accountEmail)} (${cred.status}) → ${domainClass}` +
        `${groundsEmployer ? " [grounds employer]" : ""}`,
    );

    if (!COMMIT) continue;
    const result = await recordOrgAffiliationOnConnect(cred.id);

    if (result.status === "deduped") deduped++;
    else if (result.status === "emitted") emitted++;
    else skipped++;
  }

  if (!COMMIT) {
    console.log(`\n  DRY — nothing written. Re-run with --commit to apply.`);

    return;
  }

  console.log(
    `\n  COMMITTED — emitted ${emitted}, deduped ${deduped}, skipped ${skipped} ` +
      `(of ${creds.length} credentials).`,
  );
}

async function main() {
  await warmPool();
  console.log(
    `# Backfill user_org_affiliation (#342) — mode=${COMMIT ? "COMMIT" : "DRY"} | ` +
      `targets=${TARGET_EMAILS.map(maskEmail).join(", ")}`,
  );

  const users = await db()
    .select({ userId: userTable.id, email: userTable.email })
    .from(userTable)
    .where(inArray(userTable.email, TARGET_EMAILS));

  const found = new Set(users.map((u) => u.email));
  const missing = TARGET_EMAILS.filter((e) => !found.has(e));

  if (missing.length > 0) {
    const message = `no user row for target email(s): ${missing.map(maskEmail).join(", ")}`;

    if (COMMIT) throw new Error(message);
    console.log(`! ${message} — skipping`);
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
