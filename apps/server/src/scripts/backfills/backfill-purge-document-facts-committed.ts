/**
 * Purge and canonicalize polluted `user_facts` (#330, ADR-0079). It uses the live
 * capture classifier (`gateDocumentFact`, `canonicalizeFactKey`, `isSingleValuedKey`),
 * so "junk" has one definition. Three passes per user:
 *
 *   1. Reject each document fact that fails `gateDocumentFact`. A fact whose source
 *      document is gone loses its identity claims; relationships stay.
 *   2. Re-key alias keys to the canonical key in place (`current_company` to `employer`).
 *   3. For a single-valued key with several values, keep the best row (source,
 *      then confidence, then recency) and reject the rest.
 *
 * Reject uses `rejectFact`, which is reversible and blocks re-extraction.
 *
 * Bundled for prod. Dry by default. `--commit` requires `--emails=...`. Idempotent.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfills/backfill-purge-document-facts-committed.js
 *   # commit:
 *   node dist/scripts/backfills/backfill-purge-document-facts-committed.js --emails=yashgouravkar@gmail.com --commit
 */
import { gmailSenderAdapter } from "@alfred/assistant/triage";
import { isSingleValuedKey, rejectFact, valueSignature } from "@alfred/assistant/knowledge";
import {
  gateDocumentFact,
  loadSelfIdentity,
  type SelfIdentity,
} from "@alfred/assistant/knowledge/internal";
import { warmPool } from "@alfred/db";
import { closeScriptResources } from "../script-runtime";
import { canonicalizeFactKey, getStringPath, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, user as userTable, userFacts } from "@alfred/db/schemas";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

const COMMIT = process.argv.includes("--commit");

const VERBOSE_VALUES = process.argv.includes("--verbose-values");

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

/** Active (proposed|confirmed) facts only, with the validity window applied. */
type ActiveFactRow = {
  id: string;
  key: string;
  value: unknown;
  confidence: number;
  status: string;
  source: unknown;
  updatedAt: Date | null;
  createdAt: Date | null;
};

/** Lower wins. */
function sourcePriority(source: unknown): number {
  const kind = getStringPath(source, "kind");

  switch (kind) {
    case "user":
      return 0;
    case "cold_start":
      return 1;
    case "agent":
      return 2;
    case "tool_call":
      return 3;
    case "document":
      return 4;
    default:
      return 5;
  }
}

function ts(value: Date | null): number {
  return value?.getTime() ?? 0;
}

/** The single-valued winner: source priority, then confidence, then recency. */
function pickWinner(rows: ActiveFactRow[]): ActiveFactRow {
  return [...rows].sort((a, b) => {
    const p = sourcePriority(a.source) - sourcePriority(b.source);

    if (p !== 0) return p;

    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    const u = ts(b.updatedAt) - ts(a.updatedAt);

    if (u !== 0) return u;

    return ts(b.createdAt) - ts(a.createdAt);
  })[0]!;
}

function preview(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);

  const masked = s
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]");

  return masked.length > 48 ? `${masked.slice(0, 47)}…` : masked;
}

async function reject(row: ActiveFactRow, userId: string, reason: string): Promise<boolean> {
  if (!COMMIT) return true;

  const res = await rejectFact({
    factId: row.id,
    userId,
    reason: { via: "backfill-purge-document-facts", issue: 330, key: row.key, reason },
  });

  return Boolean(res);
}

async function processUser(u: { userId: string; email: string }): Promise<void> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);
  const now = new Date();
  const selfIdentity: SelfIdentity = await loadSelfIdentity(u.userId);

  const rows: ActiveFactRow[] = await db()
    .select({
      id: userFacts.id,
      key: userFacts.key,
      value: userFacts.value,
      confidence: userFacts.confidence,
      status: userFacts.status,
      source: userFacts.source,
      updatedAt: userFacts.updatedAt,
      createdAt: userFacts.createdAt,
    })
    .from(userFacts)
    .where(
      and(
        eq(userFacts.userId, u.userId),
        inArray(userFacts.status, ["proposed", "confirmed"]),
        or(isNull(userFacts.validUntil), gt(userFacts.validUntil, now)),
      ),
    );

  // Source documents for the pass 1 authorship check.
  const docIds = Array.from(
    new Set(
      rows
        .filter((r) => getStringPath(r.source, "kind") === "document")
        .map((r) => getStringPath(r.source, "id"))
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );

  const docRows = docIds.length
    ? await db()
        .select({
          id: documents.id,
          source: documents.source,
          metadata: documents.metadata,
          accountId: documents.accountId,
        })
        .from(documents)
        .where(and(eq(documents.userId, u.userId), inArray(documents.id, docIds)))
    : [];

  const docById = new Map(docRows.map((d) => [d.id, d]));

  // Pass 1: document purge.
  const purge: Array<{ row: ActiveFactRow; reason: string }> = [];
  const surviving: ActiveFactRow[] = [];

  for (const r of rows) {
    const kind = getStringPath(r.source, "kind");

    if (kind !== "document") {
      surviving.push(r);
      continue;
    }

    const sourceId = getStringPath(r.source, "id");
    const doc = sourceId ? docById.get(sourceId) : undefined;

    // No document: an `unknown` source keeps relationships but fails identity claims.
    const gateDoc = doc
      ? {
          source: doc.source,
          metadata: doc.metadata,
          accountId: doc.accountId,
          // Triage owns the From/SENT parse (ADR-0089).
          sender: doc.source === "gmail" ? gmailSenderAdapter.authorship(doc.metadata) : null,
        }
      : { source: "unknown" as const, metadata: {}, accountId: null, sender: null };

    const gate = gateDocumentFact({
      proposal: { key: r.key, value: r.value },
      document: gateDoc,
      selfIdentity,
    });

    if (gate.ok) surviving.push(r);
    else purge.push({ row: r, reason: doc ? gate.reason : `${gate.reason}(doc_missing)` });
  }

  // Pass 2: alias-key convergence.
  const rekeys: Array<{ row: ActiveFactRow; canonicalKey: string }> = [];

  for (const r of surviving) {
    const canon = canonicalizeFactKey(r.key);

    if (canon.ok && canon.wasAlias) {
      rekeys.push({ row: r, canonicalKey: canon.key });
      r.key = canon.key; // so pass 3 groups by the canonical key
    }
  }

  // Pass 3: single-valued collapse.
  const byKey = new Map<string, ActiveFactRow[]>();

  for (const r of surviving) {
    if (!isSingleValuedKey(r.key)) continue;
    const group = byKey.get(r.key) ?? [];
    group.push(r);
    byKey.set(r.key, group);
  }

  const collapse: Array<{ row: ActiveFactRow; winnerValue: unknown }> = [];

  for (const [, group] of byKey) {
    const distinctSigs = new Set(group.map((r) => valueSignature(r.value)));

    if (group.length <= 1 || distinctSigs.size <= 1) {
      // Rows with one identical value stay. The read side dedups by value.
      continue;
    }

    const winner = pickWinner(group);

    for (const r of group) {
      if (r.id !== winner.id) collapse.push({ row: r, winnerValue: winner.value });
    }
  }

  console.log(
    `  active: ${rows.length} | document-purge ${purge.length} | ` +
      `re-key ${rekeys.length} | single-valued collapse ${collapse.length}`,
  );

  if (purge.length) {
    const byReason = new Map<string, number>();

    for (const p of purge) byReason.set(p.reason, (byReason.get(p.reason) ?? 0) + 1);
    console.log(`\n  PURGE by reason:`);

    for (const [reason, n] of [...byReason.entries()].sort()) {
      console.log(`    ${reason}: ${n}`);
    }

    const keyCounts = new Map<string, number>();

    for (const p of purge) keyCounts.set(p.row.key, (keyCounts.get(p.row.key) ?? 0) + 1);
    console.log(`  PURGE distinct keys (${keyCounts.size}):`);

    for (const key of [...keyCounts.keys()].sort()) {
      const sample = VERBOSE_VALUES ? purge.find((p) => p.row.key === key)?.row : undefined;
      console.log(`    ${key}×${keyCounts.get(key)}${sample ? ` = ${preview(sample.value)}` : ""}`);
    }
  }

  if (rekeys.length) {
    console.log(`\n  RE-KEY (alias → canonical):`);
    const pairs = new Map<string, number>();

    for (const rk of rekeys) {
      pairs.set(`→ ${rk.canonicalKey}`, (pairs.get(`→ ${rk.canonicalKey}`) ?? 0) + 1);
    }

    for (const [k, n] of [...pairs.entries()].sort()) console.log(`    ${k}: ${n}`);
  }

  if (collapse.length) {
    console.log(`\n  COLLAPSE (single-valued losers rejected): ${collapse.length}`);
    const keyCounts = new Map<string, number>();

    for (const c of collapse) keyCounts.set(c.row.key, (keyCounts.get(c.row.key) ?? 0) + 1);

    for (const key of [...keyCounts.keys()].sort()) {
      console.log(`    ${key}×${keyCounts.get(key)}`);
    }
  }

  if (!COMMIT) {
    console.log(`\n  DRY — nothing written. Re-run with --commit to apply.`);

    return;
  }

  let rejected = 0;

  for (const p of purge) if (await reject(p.row, u.userId, p.reason)) rejected++;

  let rekeyed = 0;

  for (const rk of rekeys) {
    // A collapse loser is rejected, not re-keyed.
    const isLoser = collapse.some((c) => c.row.id === rk.row.id);

    if (isLoser) continue;
    await db()
      .update(userFacts)
      .set({ key: rk.canonicalKey, rowVersion: sql`${userFacts.rowVersion} + 1` })
      .where(and(eq(userFacts.id, rk.row.id), eq(userFacts.userId, u.userId)));
    rekeyed++;
  }

  let collapsed = 0;

  for (const c of collapse)
    if (await reject(c.row, u.userId, "single_valued_conflict")) collapsed++;

  console.log(
    `\n  COMMITTED — purged ${rejected}/${purge.length}, re-keyed ${rekeyed}, ` +
      `collapsed ${collapsed}/${collapse.length}.`,
  );
}

async function main() {
  await warmPool();
  console.log(
    `# Purge+canonicalize user_facts (#330) — mode=${COMMIT ? "COMMIT" : "DRY"} | ` +
      `values=${VERBOSE_VALUES ? "masked" : "hidden"} | targets=${TARGET_EMAILS.join(", ")}`,
  );

  const users = await db()
    .select({ userId: userTable.id, email: userTable.email })
    .from(userTable)
    .where(inArray(userTable.email, TARGET_EMAILS));

  const found = new Set(users.map((u) => u.email));
  const missing = TARGET_EMAILS.filter((e) => !found.has(e));

  if (missing.length > 0) {
    const message = `no user row for target email(s): ${missing.join(", ")}`;

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
