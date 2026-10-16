/**
 * Widen the 2026-09-08 investment standing instructions to `sender_domain` (#1229).
 *
 * The user said "apply this to all investment-related senders", and capture froze that into one
 * `sender_email` row per sender seen by then. A new address at the same registrar or exchange
 * (`waareeenergies.update@in.mpms.mufg.com`, #1107) had no instruction. This script writes one
 * domain row per sender listed in `--senders`, through `rememberSenderSuppression({ scope:
 * "domain" })`, so the corporate-domain gate, the advisory lock, and the observation append all
 * run as they do for a chat capture. A domain the gate refuses is reported and not written; the
 * writer would store the one address instead, which the existing rows already cover.
 *
 * The covered `sender_email` rows stay active. A domain row strictly contains them, so they are
 * redundant but harmless. `forgetStandingInstruction` would mark them `rejected` and record a
 * rejected inference, which states that the user refused the rule. The user did not.
 *
 * Bundled for prod. Dry by default; `--commit` writes.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfills/backfill-widen-standing-instructions-committed.js
 *   # commit:
 *   node dist/scripts/backfills/backfill-widen-standing-instructions-committed.js --commit
 *   # override the user or the senders (one sender per domain):
 *   node dist/scripts/backfills/backfill-widen-standing-instructions-committed.js --email=a@x.com --senders=a@b.com,c@d.in --commit
 */
import {
  classifyBareDomain,
  domainSchema,
  emailDomain,
  normalizeEmailAddress,
  STANDING_INSTRUCTION_KEY,
  standingInstructionValueSchema,
  toMessage,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { user as userTable, userFacts } from "@alfred/db/schemas";
import { rememberSenderSuppression } from "@alfred/assistant/knowledge";
import { and, desc, eq, isNull } from "drizzle-orm";
import { closeScriptResources } from "../script-runtime";

function parseListFlag(flag: string, fallback: string): string[] {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  const raw = arg ? arg.slice(`${flag}=`.length) : fallback;

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const [TARGET_EMAIL = "yashgouravkar@gmail.com"] = parseListFlag("--email", "");

// One sender per domain. Each was checked by hand on 2026-10-16 as a broker, depository,
// exchange, or registrar domain that sends only investment notices (#1229).
const SENDERS = parseListFlag(
  "--senders",
  [
    "no-reply-contract-notes@reportsmailer.zerodha.net",
    "alerts@mailer.zerodha.com",
    "services@cdslindia.co.in",
    "evoting@nsdl.com",
    "nse_alerts@nse.co.in",
    "info@bseindia.in",
    "waareeenergies.update@in.mpms.mufg.com",
  ].join(","),
);

const COMMIT = process.argv.includes("--commit");

interface ActiveAddressRow {
  factId: string;
  email: string;
  phrasing: string;
}

async function activeAddressRows(userId: string): Promise<ActiveAddressRow[]> {
  const rows = await db()
    .select({ id: userFacts.id, value: userFacts.value })
    .from(userFacts)
    .where(
      and(
        eq(userFacts.userId, userId),
        eq(userFacts.key, STANDING_INSTRUCTION_KEY),
        eq(userFacts.status, "confirmed"),
        isNull(userFacts.validUntil),
      ),
    )
    .orderBy(desc(userFacts.validFrom));

  const out: ActiveAddressRow[] = [];

  for (const row of rows) {
    const parsed = standingInstructionValueSchema.safeParse(row.value);

    if (!parsed.success || parsed.data.target.kind !== "sender_email") continue;

    out.push({ factId: row.id, email: parsed.data.target.email, phrasing: parsed.data.phrasing });
  }

  return out;
}

async function main(): Promise<void> {
  console.log(
    `# Widen standing instructions to sender_domain (#1229) — mode=${COMMIT ? "COMMIT" : "DRY"} | user=${TARGET_EMAIL}`,
  );

  const [u] = await db()
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, TARGET_EMAIL))
    .limit(1);

  if (!u) {
    console.log(`! no user row for ${TARGET_EMAIL}`);

    return;
  }

  const addressRows = await activeAddressRows(u.id);
  // Newest first, so this is the user's latest wording of the instruction.
  const fallbackPhrasing = addressRows[0]?.phrasing ?? null;

  for (const raw of SENDERS) {
    const sender = normalizeEmailAddress(raw);
    const domain = domainSchema.safeParse(emailDomain(sender));

    if (!sender || !domain.success) {
      console.log(`! ${raw}: not a parseable address — skipped`);
      continue;
    }

    const domainClass = classifyBareDomain({ domain: domain.data });

    if (domainClass !== "corporate_domain") {
      console.log(`- ${domain.data}: gate says ${domainClass ?? "invalid"} — not widened`);
      continue;
    }

    const covered = addressRows.filter((row) => emailDomain(row.email) === domain.data);
    const phrasing = covered[0]?.phrasing ?? fallbackPhrasing;

    console.log(
      `+ ${domain.data}: covers ${covered.length} active address row(s)${covered.length ? ` (${covered.map((r) => r.email).join(", ")})` : ""}`,
    );

    if (!COMMIT) continue;

    const result = await rememberSenderSuppression({
      userId: u.id,
      senderEmail: sender,
      scope: "domain",
      phrasing,
      source: { kind: "user", meta: { via: "backfill", issue: 1229 } },
    });

    if (!result.ok) {
      console.log(`  ! ${result.status}: ${result.message}`);
      continue;
    }

    const kind = result.instruction.target.kind;

    console.log(
      `  ${result.status} ${result.factId} kind=${kind}${result.scopeNarrowing ? ` narrowed=${result.scopeNarrowing}` : ""} overlaps=${result.overlapCount}`,
    );
  }

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
