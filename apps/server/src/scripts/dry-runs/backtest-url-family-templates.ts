/**
 * Back-test of URL-family identity templates over stored Gmail documents
 * (docs/plans/url-family-identity-templates.md section 5). Read-only. It drives the real link
 * parser and prints, for each template, its keys with their mails in time order, the gate
 * results, and the negative control.
 *
 *   $ pnpm --filter server exec tsx --env-file=<main-checkout>/apps/server/.env \
 *       src/scripts/dry-runs/backtest-url-family-templates.ts <templates.json> <userId> [days]
 *
 * `templates.json` is an array of templates. `days` defaults to 35. Exit code 1 when a template
 * does not parse or does not pass.
 */

import { readFile } from "node:fs/promises";
import {
  backtestUrlFamilyTemplate,
  type BacktestMail,
  type UrlFamilyBacktest,
} from "@alfred/assistant/connections/object-state/url-family-backtest";
import {
  parseGmailDocumentMetadata,
  safeJsonParse,
  urlFamilyTemplateSchema,
} from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { createHash } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import { z } from "zod";

const DEFAULT_DAYS = 35;

const DAY_MS = 24 * 60 * 60 * 1000;

async function loadMails(userId: string, days: number): Promise<BacktestMail[]> {
  const rows = await db()
    .select({
      id: documents.id,
      threadId: documents.sourceThreadId,
      subject: documents.title,
      content: documents.content,
      metadata: documents.metadata,
      authoredAt: documents.authoredAt,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "gmail"),
        gte(documents.authoredAt, new Date(Date.now() - days * DAY_MS)),
      ),
    );

  return rows.map(({ metadata, ...row }) => ({
    ...row,
    from: parseGmailDocumentMetadata(metadata).from ?? null,
  }));
}

/** A short stable label, so the report does not print the identity values. */
function keyLabel(key: readonly string[]): string {
  return createHash("sha256").update(key.join("\u0000")).digest("hex").slice(0, 6);
}

function printReport(report: UrlFamilyBacktest): void {
  const { template, keys, control } = report;
  const reopened = keys.filter((key) => key.reopened).length;

  console.log(
    `\n## ${template.provider}.${template.kind} (${template.lifecycle}): ${report.passed ? "PASS" : "FAIL"}`,
  );
  console.log(
    `sender mails=${report.senderMails} keyed mails=${keys.reduce((n, key) => n + key.mails.length, 0)} ` +
      `keys=${keys.length} ambiguous=${report.ambiguousMails.length} ` +
      `coverage misses=${report.coverageMisses.length} reopened=${reopened}`,
  );
  console.log(
    control
      ? `control (containers as identity): ${control.failed ? "FAIL, as required" : "PASS, so the mail cannot tell a container from an item"} (reopened=${control.reopenedKeys})`
      : "control: none (no containers)",
  );

  if (report.unmatchedHosts.size > 0) {
    console.log(
      `links on template hosts that matched no pattern: ${JSON.stringify([...report.unmatchedHosts])}`,
    );
  }

  for (const key of keys) {
    console.log(
      `- key#${keyLabel(key.key)} threads=${new Set(key.mails.map((m) => m.mail.threadId)).size}${key.reopened ? " <-- REOPENED" : ""}`,
    );

    for (const { mail, state } of key.mails) {
      console.log(
        `    ${mail.authoredAt?.toISOString() ?? "-"} [${state ?? "-"}] ${mail.subject ?? ""}`,
      );
    }
  }

  for (const mail of report.ambiguousMails)
    console.log(`  ambiguous: ${mail.id} ${mail.subject ?? ""}`);

  for (const mail of report.coverageMisses) console.log(`  miss: ${mail.id} ${mail.subject ?? ""}`);
}

async function main(): Promise<number> {
  const [path, userId, rawDays] = process.argv.slice(2);

  if (!path || !userId) {
    console.error("usage: backtest-url-family-templates.ts <templates.json> <userId> [days]");

    return 2;
  }

  const parsed = z
    .array(urlFamilyTemplateSchema)
    .safeParse(safeJsonParse(await readFile(path, "utf8")));

  if (!parsed.success) {
    console.error(z.prettifyError(parsed.error));

    return 1;
  }

  const requested = Number(rawDays);
  const days = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_DAYS;
  const mails = await loadMails(userId, days);

  console.log(`mails=${mails.length} days=${days}`);

  const reports = parsed.data.map((template) => backtestUrlFamilyTemplate(template, mails));

  reports.forEach(printReport);

  return reports.every((report) => report.passed) ? 0 : 1;
}

try {
  process.exitCode = await main();
} finally {
  await closeConnections();
}
