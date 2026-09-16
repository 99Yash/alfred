/**
 * Widen every active standing instruction to the effects registered TODAY.
 *
 * Why this exists: `rememberSenderSuppression` writes
 * `effects: [...SUPPRESSION_EFFECTS]` unconditionally, so the stored array is a
 * snapshot of the effect registry at write time, never a choice between
 * effects. An instruction written before an effect was registered therefore
 * under-states what the user asked for. Measured on prod 2026-09-16: twelve
 * investment-sender suppressions whose `phrasing` reads "do not tag
 * stock-related emails as urgent" carried no effect a classifier could read, so
 * `nse_alerts@nse.co.in` kept landing `action_needed` three days after the ask.
 *
 * It carries `directive` and `phrasing` VERBATIM and supersedes each row
 * (`supersedesId` + a `user_standing_instruction` observation), so every
 * widening is auditable and reversible. Idempotent: a row already carrying
 * every registered effect is skipped.
 *
 * Bundled by tsdown (`noExternal: @alfred/*`) so it runs on prod with plain
 * `node dist/scripts/backfills/backfill-standing-instruction-effects-committed.js`.
 *
 * Dry by default — prints what it WOULD widen and writes nothing. `--commit`
 * applies and REQUIRES `--emails=...` explicitly, so a prod shell typo cannot
 * mutate the default account.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfills/backfill-standing-instruction-effects-committed.js --emails=you@example.com
 *   # commit:
 *   node dist/scripts/backfills/backfill-standing-instruction-effects-committed.js --emails=you@example.com --commit
 */
import {
  adoptRegisteredSuppressionEffects,
  listActiveSuppressionInstructions,
} from "@alfred/assistant/knowledge";
import { SUPPRESSION_EFFECTS, toMessage } from "@alfred/contracts";
import { db, warmPool } from "@alfred/db";
import { user as userTable } from "@alfred/db/schemas";
import { inArray } from "drizzle-orm";
import { closeScriptResources } from "../script-runtime";

const COMMIT = process.argv.includes("--commit");

function emailsArg(): string[] {
  const raw = process.argv.find((arg) => arg.startsWith("--emails="));

  if (!raw) return [];

  return raw
    .slice("--emails=".length)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const emails = emailsArg();

  if (emails.length === 0) {
    throw new Error("--emails=a@b.com[,c@d.com] is required (dry runs included)");
  }

  await warmPool();

  const users = await db()
    .select({ id: userTable.id, email: userTable.email })
    .from(userTable)
    .where(inArray(userTable.email, emails));

  if (users.length === 0) throw new Error(`no user matched --emails=${emails.join(",")}`);

  for (const row of users) {
    const active = await listActiveSuppressionInstructions(row.id);

    const stale = active.filter((instruction) =>
      SUPPRESSION_EFFECTS.some((effect) => !instruction.value.effects.includes(effect)),
    );

    console.log(`\n${row.email}: ${active.length} active, ${stale.length} missing an effect`);

    for (const instruction of stale) {
      const missing = SUPPRESSION_EFFECTS.filter(
        (effect) => !instruction.value.effects.includes(effect),
      );

      console.log(`  ${instruction.value.target.email} += [${missing.join(", ")}]`);
    }

    if (!COMMIT) {
      console.log("  (dry run — pass --commit to write)");
      continue;
    }

    const result = await adoptRegisteredSuppressionEffects({ userId: row.id });

    console.log(`  widened ${result.upgraded.length}, skipped ${result.skipped}`);
  }
}

main()
  .catch((err) => {
    console.error(`[backfill-standing-instruction-effects] ${toMessage(err)}`);
    process.exitCode = 1;
  })
  .finally(closeScriptResources);
