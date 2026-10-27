// Fixtures for the rules whose matching is not obvious by reading the regex.
//
// Why this exists: `unguarded-agent-run-status-write` shipped as a one-line
// regex over an idiom the formatter splits across four lines, so it matched
// zero of the repo's six `agent_runs` write sites and its clean run said
// "no drift" rather than "cannot see anything". A rule nobody has watched fire
// is an assertion, not enforcement. These fixtures make every `pnpm check` run
// the rule against the exact regression it was written for (the `markRunFailed`
// body removed in cf6cf2b1) plus the shapes it must NOT flag.
//
// Only add a fixture when the answer is load-bearing: a false positive would
// block a build and a false negative would let a real bug through.
//
// Every `gate` row is load-bearing by definition, because it fails the build.
// So every gate needs at least one must-catch fixture that names it, and
// `gateCoverageFailures` fails `pnpm check` when one has none. There is no
// allowlist of uncovered gates on purpose: a row in such a list pre-authorizes
// the exact hole this file exists to expose. `raw-gmail-token-call` let a
// namespace import through for as long as it had no fixture.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { matchChains, matchLine, REGISTRY_UNION, RULES } from "./consolidation-rules.mjs";

/**
 * The file whose `export type …Slug` / `…Provider` names the
 * `partial-integration-slug-record` rule must cover. Read from the script's
 * own location, so a worktree resolves it the same way the repo root does.
 */
const REGISTRY_SLUGS_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/contracts/src/integrations/slugs.ts",
);

/**
 * Every derived union in the registry, as a `Partial<Record<…>>` fixture the
 * rule must catch. An absent or empty file is a failure, not an empty list: the
 * rule's alternation is a hand-typed list, and this drive is the only thing that
 * proves it did not lag `slugs.ts`. When the file moves, repoint
 * REGISTRY_SLUGS_FILE; do not skip.
 */
function registryUnionFailures() {
  let source;

  try {
    source = readFileSync(REGISTRY_SLUGS_FILE, "utf8");
  } catch {
    return [
      `registry unions: cannot read ${REGISTRY_SLUGS_FILE}; repoint REGISTRY_SLUGS_FILE or delete the rule`,
    ];
  }

  const names = [...source.matchAll(/^export type (\w+(?:Slug|Provider))\b/gm)].map((m) => m[1]);

  if (names.length === 0) {
    return [
      `registry unions: no \`export type …Slug\` in ${REGISTRY_SLUGS_FILE}; the drive has nothing to prove`,
    ];
  }

  const union = new RegExp(`^${REGISTRY_UNION}$`);

  return names
    .filter((name) => !union.test(name))
    .map(
      (name) => `registry union ${name} escapes REGISTRY_UNION in partial-integration-slug-record`,
    );
}

/** A source file the rule is not exempt in. */
const FILE = "packages/api/src/modules/agent/executor.ts";

/**
 * A file inside a package test tree. `db-backed-skip-hand-rolled` names its own
 * `paths`, so the file a fixture claims to be is part of the answer, not scenery.
 */
const TEST_TREE_FILE = "packages/assistant/test/flags.behavior.test.ts";

/**
 * One of the three `packages/assistant/src/knowledge/` files
 * `hand-rolled-whitespace-collapse` names in `owners`. Those folds feed a
 * persisted `EntityKind` decision and a `holdsResearchPrior` guard, not a
 * display, so the file a fixture claims to be is part of the answer here too.
 */
const KNOWLEDGE_OWNER_FILE = "packages/assistant/src/knowledge/entity-kind-classifier.ts";

/**
 * A non-owner file beside `gmail.ts`. `raw-gmail-token-call` exempts only
 * `mailbox.ts`, so the sibling that imports `./gmail` is where a fixture lives.
 */
const GMAIL_SIBLING_FILE = "packages/integrations/src/google/client.ts";

/**
 * @type {{name: string, caught: boolean, code: string, file?: string, rule?: string, lanes?: "gate"|"all"}[]} `file`
 *   defaults to {@link FILE}; name it only when the rule under test scopes on the
 *   path. `rule` names the rule id that must fire: `selfTestFailures` asserts the
 *   match attributes to it, so a dead row cannot hide behind another rule's
 *   match (a-green-lint-run-cannot-tell-an-armed-fence-from-a-dead-one).
 *   Required when `caught` is true, because the named ids are also what
 *   {@link gateCoverageFailures} counts. A must-ignore fixture omits it: it
 *   asserts that NO rule in the lane fires.
 *   `lanes` defaults to `"gate"`; a `hint` row needs `"all"`, because a hint
 *   never fires in the gate lane `pnpm check` enforces.
 */
const CASES = [
  {
    name: "hand-rolled-no-reply-regex — a local no-reply prefix regex",
    caught: true,
    rule: "hand-rolled-no-reply-regex",
    code: `const PREFIX_RE = /^(no[-_.]?reply|alerts?)/;`,
  },
  {
    name: "hand-rolled-no-reply-regex — a local no-reply word Set, one member per line",
    caught: true,
    rule: "hand-rolled-no-reply-regex",
    code: `const STRONG = new Set<string>([
  "noreply",
  "no-reply",
]);`,
  },
  {
    name: "hand-rolled-no-reply-regex — a no-reply address is not a word list",
    caught: false,
    code: `const from = "GitHub <noreply@github.com>";`,
  },
  {
    name: "receipt read must select the typed view, including across line breaks",
    caught: true,
    rule: "unfiltered-event-receipt-read",
    code: `.from(
 eventReceipts
)`,
  },
  {
    name: "receipt joins must select the typed view",
    caught: true,
    rule: "unfiltered-event-receipt-read",
    code: `.innerJoin(eventReceipts, condition)`,
  },
  {
    name: "typed receipt view is the safe query source",
    caught: false,
    code: `.from(typedEventReceipts)`,
  },
  ...[
    "packages/db/src/schema/integrations.ts",
    "packages/assistant/src/connections/ingestion/inbound-receive.ts",
    "packages/assistant/src/connections/raw-receipt-inventory.ts",
  ].map((file) => ({
    name: `full receipt reader: ${file}`,
    caught: false,
    file,
    code: `.from(eventReceipts)`,
  })),
  {
    name: "raw-user-preferences-query — a select split across lines",
    caught: true,
    rule: "raw-user-preferences-query",
    code: `db()
  .select({ key: userPreferences.key })
  .from(
    userPreferences
  )`,
  },
  {
    name: "raw-user-preferences-query — a write in a tx",
    caught: true,
    rule: "raw-user-preferences-query",
    code: `await tx.insert(userPreferences).values(row).onConflictDoNothing();`,
  },
  {
    name: "raw-user-preferences-query — a read through the bind",
    caught: false,
    code: `const rows = await settings({ userId }).all();`,
  },
  ...[
    "packages/assistant/src/settings/preferences.ts",
    "packages/http/src/sync/read/preferences.ts",
  ].map((file) => ({
    name: `raw-user-preferences-query — sanctioned owner: ${file}`,
    caught: false,
    file,
    code: `.from(userPreferences)`,
  })),
  {
    name: "as-loose-record — direct boundary assertion",
    caught: true,
    rule: "as-loose-record",
    code: `const payload = input as Record<string, unknown>;`,
  },
  {
    name: "as-loose-record — multiline record assertion nested in ReadonlyArray",
    caught: true,
    rule: "as-loose-record",
    code: `const rows = input as ReadonlyArray<
      Record< string, unknown >
    >;`,
  },
  {
    name: "as-loose-record — an honest open-record declaration is not an assertion",
    caught: false,
    code: `const payload: Record<string, unknown> = {};`,
  },
  {
    name: "as-loose-record — an honest generic dictionary constraint is not an assertion",
    caught: false,
    code: `function copy<T extends Record<string, unknown>>(value: T): T {`,
  },
  {
    name: "D1 verbatim — markRunFailed, the write that resurrected cancelled runs (#530)",
    caught: true,
    rule: "unguarded-agent-run-status-write",
    code: `
async function markRunFailed(runId: string, error: string): Promise<void> {
  await db()
    .update(agentRuns)
    .set({
      status: "failed",
      // A comment inside the payload must not end the match.
      error: { message: sanitizeErrorMessage(error) },
      endedAt: new Date(),
    })
    .where(eq(agentRuns.id, runId));
}`,
  },
  {
    name: "nested error object BEFORE status — invisible to a brace-bounded regex",
    caught: true,
    rule: "unguarded-agent-run-status-write",
    code: `
  await tx
    .update(agentRuns)
    .set({ error: { message: m, step: s }, status: "failed" })
    .where(eq(agentRuns.id, id));`,
  },
  {
    name: "hand-collapsed one-liner",
    caught: true,
    rule: "unguarded-agent-run-status-write",
    code: `  await tx.update(agentRuns).set({ status: "cancelled" }).where(eq(agentRuns.id, id));`,
  },
  {
    name: "spread payload with shorthand status",
    caught: true,
    rule: "unguarded-agent-run-status-write",
    code: `await tx.update(agentRuns).set({ ...base, status }).where(eq(agentRuns.id, id));`,
  },
  {
    name: "computed status key",
    caught: true,
    rule: "unguarded-agent-run-status-write",
    code: `await tx.update(agentRuns).set({ ["status"]: next }).where(eq(agentRuns.id, id));`,
  },
  {
    name: "status upsert",
    caught: true,
    rule: "unguarded-agent-run-status-upsert",
    code: `await tx.insert(agentRuns).values(row).onConflictDoUpdate({ target: agentRuns.id, set: { status } });`,
  },
  {
    name: "raw status SQL",
    caught: true,
    rule: "raw-agent-run-status-sql",
    code: "await tx.execute(sql`UPDATE agent_runs SET status = 'failed' WHERE id = ${id}`);",
  },
  {
    name: "separate statements — agentSteps owns the status, agentRuns write is benign",
    caught: false,
    code: `
  await tx.update(agentRuns).set({ lastCheckpointAt: now }).where(eq(agentRuns.id, id));
  await tx
    .update(agentSteps)
    .set({ status: "completed" })
    .where(eq(agentSteps.id, stepRowId));`,
  },
  {
    name: "heartbeat — an agentRuns write with no status key",
    caught: false,
    code: `
  await db()
    .update(agentRuns)
    .set({ lastCheckpointAt: new Date() })
    .where(and(...conds));`,
  },
  {
    name: "a read filtered by status",
    caught: false,
    code: `  const rows = await tx.select().from(agentRuns).where(eq(agentRuns.status, "running"));`,
  },
  {
    name: "doc-comment example of the banned idiom",
    caught: false,
    code: `
/**
 * Never write it like this:
 *   await tx.update(agentRuns).set({ status: "failed" }).where(eq(agentRuns.id, id));
 */`,
  },
  {
    name: "drift-ok in the comment block above the chain",
    caught: false,
    code: `
  await tx
    // drift-ok: FOR UPDATE held since the SELECT above, status checked under it.
    .update(agentRuns)
    .set({ status: "failed" })
    .where(eq(agentRuns.id, id));`,
  },
  {
    name: "empty drift-ok reason does not exempt",
    caught: true,
    rule: "unguarded-agent-run-status-write",
    code: `
  await tx
    // drift-ok:
    .update(agentRuns)
    .set({ status: "failed" })
    .where(eq(agentRuns.id, id));`,
  },
  {
    name: "db-backed-skip-hand-rolled — the inline ternary guard, the shape 12 suites carried",
    caught: true,
    rule: "db-backed-skip-hand-rolled",
    file: TEST_TREE_FILE,
    code: `const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";`,
  },
  {
    name: "db-backed-skip-hand-rolled — the databaseEnv() variant conflates absent with malformed",
    caught: true,
    rule: "db-backed-skip-hand-rolled",
    file: TEST_TREE_FILE,
    code: `    return Boolean(databaseEnv().DATABASE_URL);`,
  },
  {
    // The order control. A `reader .* name` regex reads left to right, so this
    // form — the one `action-policies/barrel-load.test.ts` already names in
    // prose — escaped it silently. The rule pairs two lookaheads instead.
    name: "db-backed-skip-hand-rolled — a destructured read puts the variable name first",
    caught: true,
    rule: "db-backed-skip-hand-rolled",
    file: TEST_TREE_FILE,
    code: `const { DATABASE_URL } = process.env;`,
  },
  {
    name: "db-backed-skip-hand-rolled — a destructured read off serverEnv() fires too",
    caught: true,
    rule: "db-backed-skip-hand-rolled",
    file: TEST_TREE_FILE,
    code: `  const { REDIS_URL } = serverEnv();`,
  },
  {
    name: "db-backed-skip-hand-rolled — the sanctioned call site names no variable",
    caught: false,
    file: TEST_TREE_FILE,
    code: `const SKIP = dbBackedSkip("database");`,
  },
  {
    name: "db-backed-skip-hand-rolled — the helper's own loop has a reader but no variable name",
    caught: false,
    file: "packages/assistant/test/support/db-backed.ts",
    code: `  const missing = REQUIRED_VARIABLES[requires].filter((name) => !process.env[name]);`,
  },
  {
    name: "db-backed-skip-hand-rolled — a stated drift-ok reason exempts a non-guard reader",
    caught: false,
    file: TEST_TREE_FILE,
    code: `  delete process.env["DATABASE_URL"]; // drift-ok: the test needs the variable absent`,
  },
  {
    // The control for `paths` in the OTHER direction. Without it, a rule whose
    // regex happens to be broad could scope to the whole repo and nothing here
    // would notice; the same text must stay silent in `src/`, where the helper
    // this rule points at does not exist.
    name: "db-backed-skip-hand-rolled — the same drift text outside a test tree does not fire",
    caught: false,
    file: "packages/assistant/src/flags.ts",
    code: `const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";`,
  },
  {
    name: "hand-rolled-nested-transaction — the two restated savepoint sites (push.ts, service.ts)",
    caught: true,
    rule: "hand-rolled-nested-transaction",
    code: `
async function applyMutation(tx: DbTransaction) {
  await tx.transaction(async (subTx: DbTx) => {
    await subTx.execute(sql\`insert into probe (id) values (1)\`);
  });
}`,
  },
  {
    name: "hand-rolled-nested-transaction — the sanctioned db().transaction root client never matches",
    caught: false,
    code: `
const row = await db().transaction(async (tx) => {
  return tx.execute(sql\`select 1\`);
});`,
  },
  {
    name: "hand-rolled-nested-transaction — an adapter-interface call without its marker fires (the marker is what saves it)",
    caught: true,
    rule: "hand-rolled-nested-transaction",
    code: `
  transaction: (callback) =>
    adapter.transaction((trx) => callback(decorateOperations(trx, resolved) as typeof trx)),`,
  },
  {
    name: "hand-rolled-nested-transaction — the adapter-interface call with its drift-ok comment block above",
    caught: false,
    code: `
  transaction: (callback) =>
    // drift-ok: Better-Auth adapter interface — its transaction wraps db().transaction internally
    adapter.transaction((trx) => callback(decorateOperations(trx, resolved) as typeof trx)),`,
  },
  // `hand-rolled-object-closure`, one fixture per spelling the rule covers.
  // The rule is chain-scoped for the `switch` arm alone, so every other arm is
  // still a one-line fixture — it just lives in this lane because a rule
  // belongs to exactly one lane.
  {
    name: "hand-rolled-object-closure — the category tested against the closing literals",
    caught: true,
    rule: "hand-rolled-object-closure",
    code: `if (card.object.stateCategory === "resolved") return "closed";`,
  },
  {
    name: "hand-rolled-object-closure — the same test written the other way round",
    caught: true,
    rule: "hand-rolled-object-closure",
    code: `if ("abandoned" === object.stateCategory) markHandled(object);`,
  },
  {
    name: "hand-rolled-object-closure — the local rename the sanctioned reader itself makes",
    caught: true,
    rule: "hand-rolled-object-closure",
    code: `if (category === "resolved") return "closed";`,
  },
  {
    name: "hand-rolled-object-closure — the inversion, which calls a failed build closed",
    caught: true,
    rule: "hand-rolled-object-closure",
    code: `if (stateCategory !== "active") markHandled(object);`,
  },
  {
    name: "hand-rolled-object-closure — the membership test re-implemented over the tuple",
    caught: true,
    rule: "hand-rolled-object-closure",
    code: `const closed = LOOP_CLOSING_STATE_CATEGORIES.includes(row.stateCategory);`,
  },
  {
    name: "hand-rolled-object-closure — the same membership test spelled with some()",
    caught: true,
    rule: "hand-rolled-object-closure",
    code: `const closed = LOOP_CLOSING_STATE_CATEGORIES.some((c) => c === row.category);`,
  },
  {
    name: "hand-rolled-object-closure — the tuple reaching includes() through a cast",
    caught: true,
    rule: "hand-rolled-object-closure",
    code: `  return (LOOP_CLOSING_STATE_CATEGORIES as readonly string[]).includes(category);`,
  },
  {
    name: "hand-rolled-object-closure — the tuple spelled out inline as an array literal",
    caught: true,
    rule: "hand-rolled-object-closure",
    code: `const closed = ["resolved", "abandoned"].includes(category);`,
  },
  {
    name: "hand-rolled-object-closure — the switch a closed union invites, whose case is a later line",
    caught: true,
    rule: "hand-rolled-object-closure",
    code: `
switch (stateCategory) {
  case "active":
    return null;
  case "resolved":
    return "closed";
}`,
  },
  {
    name: "the tuple as a schema enum is a declaration, not a closure reading",
    caught: false,
    code: `  stateCategory: z.enum(LOOP_CLOSING_STATE_CATEGORIES),`,
  },
  {
    name: "the registry declaring which categories a kind closes on is the owner of the policy",
    caught: false,
    code: `        closesAskOn: LOOP_CLOSING_STATE_CATEGORIES,`,
  },
  {
    name: "the closing tuple's own declaration names both literals and reads nothing",
    caught: false,
    code: `export const LOOP_CLOSING_STATE_CATEGORIES = ["resolved", "abandoned"] as const;`,
  },
  {
    name: "a membership test over another tuple is not this row's business",
    caught: false,
    code: `  return (OTHER_STATE_CATEGORIES as readonly string[]).includes(category);`,
  },
  {
    name: "the sanctioned reader's own absent-category guard is not a closure reading",
    caught: false,
    code: `  if (object.stateCategory === undefined) return null;`,
  },
  {
    name: "an honest activeness test is not the inversion",
    caught: false,
    code: `  if (stateCategory === "active") return renderOpenAsk(object);`,
  },
  {
    name: "a triage category tested against a triage word is a different vocabulary",
    caught: false,
    code: `  if (classification.category !== "action_needed") return false;`,
  },
  {
    name: "a switch on a category whose cases are triage words",
    caught: false,
    code: `
switch (category) {
  case "chat":
    return "Chat turn";
  case "triage":
    return "Email triage";
}`,
  },
  {
    name: "delegating to the registry is the intended form",
    caught: false,
    code: `  return closesOpenAsk(object.provider, object.kind, object.stateCategory, "stored_projection");`,
  },
  {
    name: "hand-rolled-object-closure — the sibling export that answers the same question in one argument",
    caught: true,
    rule: "hand-rolled-object-closure",
    code: `if (isTerminalCategory(object.stateCategory)) return "closed";`,
  },
  {
    name: "hand-rolled-object-closure — the sharper spelling of the same wrong reading",
    caught: true,
    rule: "hand-rolled-object-closure",
    code: `const closed = isTerminalCategory(category) && category !== "failed";`,
  },
  {
    name: "hand-rolled-object-closure — the membership test spelled through a Set",
    caught: true,
    rule: "hand-rolled-object-closure",
    code: `const closed = new Set(LOOP_CLOSING_STATE_CATEGORIES).has(category);`,
  },
  {
    name: "hand-rolled-object-closure — the membership test spelled with find()",
    caught: true,
    rule: "hand-rolled-object-closure",
    code: `const hit = LOOP_CLOSING_STATE_CATEGORIES.find((c) => c === row.category);`,
  },
  {
    name: "hand-rolled-object-closure — a rename that no longer ends in category",
    rule: "hand-rolled-object-closure",
    caught: true,
    code: `const closed = card.object.stateCategory;\nif (closed === "resolved") return "closed";`,
  },
  {
    name: "hand-rolled-object-closure — the rename in destructuring form",
    rule: "hand-rolled-object-closure",
    caught: true,
    code: `const { stateCategory: closed } = card.object;\nif (closed === "resolved") return "closed";`,
  },
  {
    name: "hand-rolled-object-closure — a default under a renamed identifier",
    rule: "hand-rolled-object-closure",
    caught: true,
    code: `const state = object.stateCategory ?? "active";\nif (state === "resolved" || state === "abandoned") return "closed";`,
  },
  {
    name: "hand-rolled-object-closure — the inversion under a renamed identifier",
    rule: "hand-rolled-object-closure",
    caught: true,
    code: `const kindState = object.stateCategory;\nif (kindState !== "active") return "closed";`,
  },
  {
    name: "hand-rolled-object-closure — the renamed comparison written literal-first",
    rule: "hand-rolled-object-closure",
    caught: true,
    code: `const closed = card.object.stateCategory;\nif ("resolved" === closed) return "closed";`,
  },
  {
    name: "hand-rolled-object-closure — the comparison prettier wraps across two lines",
    rule: "hand-rolled-object-closure",
    caught: true,
    code: `if (category ===\n  "resolved") return "closed";`,
  },
  {
    name: "hand-rolled-object-closure — the lookup table composed with a subscript read",
    rule: "hand-rolled-object-closure",
    caught: true,
    code: `const CLOSES = { resolved: true, abandoned: true, active: false, failed: false };\nif (CLOSES[category]) return "closed";`,
  },
  {
    name: "hand-rolled-object-closure — a case past the old 600-character bound",
    rule: "hand-rolled-object-closure",
    caught: true,
    code: `
switch (stateCategory) {
  case "active":
    track("open");
    return renderOpenAsk(object);
  case "failed":
    track("failed");
    return renderOpenAsk(object);
  case "active":
    track("open");
    return renderOpenAsk(object);
  case "failed":
    track("failed");
    return renderOpenAsk(object);
  case "active":
    track("open");
    return renderOpenAsk(object);
  case "failed":
    track("failed");
    return renderOpenAsk(object);
  case "active":
    track("open");
    return renderOpenAsk(object);
  case "failed":
    track("failed");
    return renderOpenAsk(object);
  case "active":
    track("open");
    return renderOpenAsk(object);
  case "resolved":
    return "closed";
}`,
  },
  {
    name: "hand-rolled-object-closure — the row's own keyword inside a string no longer breaks the span",
    rule: "hand-rolled-object-closure",
    caught: true,
    code: `
switch (stateCategory) {
  case "active":
    log("switch the lights");
    break;
  case "resolved":
    return "closed";
}`,
  },
  {
    name: "reintroducing isTerminalCategory: its declaration stays exempt via the function lookbehind",
    caught: false,
    code: `export function isTerminalCategory(category: StateCategory): category is TerminalStateCategory {`,
  },
  {
    name: "a second switch standing next to the first owns its own cases",
    caught: false,
    code: `
switch (toolCategory) {
  case "source":
    return "Source";
}

switch (mergeStatus) {
  case "resolved":
    return "Merged";
}`,
  },
  {
    name: "a switch nested inside a category switch owns its own cases",
    caught: false,
    code: `
switch (resultCategory) {
  case "join": {
    switch (identity.status) {
      case "resolved":
        return "Joined";
    }
  }
}`,
  },
  {
    name: "two unrelated comparisons on one ternary line are not one reading",
    caught: false,
    code: `const label = category === "triage" ? "Email" : identity.status === "resolved" ? "Done" : "";`,
  },
  {
    // `hand-rolled-whitespace-collapse` replaced eleven copies of this line.
    // The catch cases are the spellings an author reaches for; the ignore cases
    // are the near-misses that share the `\s+` shape and do a different job.
    name: "hand-rolled-whitespace-collapse — the display fold eleven sites hand-rolled",
    rule: "hand-rolled-whitespace-collapse",
    caught: true,
    code: String.raw`  const collapsed = text.replace(/\s+/g, " ").trim();`,
  },
  {
    name: "hand-rolled-whitespace-collapse — replaceAll with the unicode flag is the same fold",
    rule: "hand-rolled-whitespace-collapse",
    caught: true,
    code: String.raw`  const collapsed = text.replaceAll(/\s+/gu, " ").trim();`,
  },
  {
    name: "hand-rolled-whitespace-collapse — the character-class spelling of the same run",
    rule: "hand-rolled-whitespace-collapse",
    caught: true,
    code: String.raw`  const collapsed = text.replace(/[\s]+/g, " ").trim();`,
  },
  {
    // The three spellings of the run. `/\s{2,}/` and `/\s\s+/` differ from
    // `/\s+/` only on a lone whitespace character, which a display fold wants
    // normalized anyway — so they are the same idiom, not near-misses. Before
    // the rule enumerated them, `triage/classify.ts` folded an assist line in
    // the `{2,}` spelling and the gate stayed green.
    name: "hand-rolled-whitespace-collapse — the {2,} spelling of the same run",
    rule: "hand-rolled-whitespace-collapse",
    caught: true,
    code: String.raw`  const collapsed = text.replace(/\s{2,}/g, " ").trim();`,
  },
  {
    name: "hand-rolled-whitespace-collapse — the character class with the {2,} quantifier",
    rule: "hand-rolled-whitespace-collapse",
    caught: true,
    code: String.raw`  const collapsed = text.replace(/[\s]{2,}/g, " ").trim();`,
  },
  {
    name: "hand-rolled-whitespace-collapse — the doubled-atom spelling of the same run",
    rule: "hand-rolled-whitespace-collapse",
    caught: true,
    code: String.raw`  const collapsed = text.replace(/\s\s+/g, " ").trim();`,
  },
  {
    // The doubled-atom form takes the character class on either atom
    // independently, so the rule reads it on each atom independently too. An
    // earlier regex spelled the two atoms literally and both of these evaded it
    // while the comment above the rule claimed they did not.
    name: "hand-rolled-whitespace-collapse — the doubled atom with the class on the first atom",
    rule: "hand-rolled-whitespace-collapse",
    caught: true,
    code: String.raw`  const collapsed = text.replace(/[\s]\s+/g, " ").trim();`,
  },
  {
    name: "hand-rolled-whitespace-collapse — the doubled atom with the class on both atoms",
    rule: "hand-rolled-whitespace-collapse",
    caught: true,
    code: String.raw`  const collapsed = text.replace(/[\s][\s]+/g, " ").trim();`,
  },
  {
    name: "hand-rolled-whitespace-collapse — single quotes around the replacement space",
    rule: "hand-rolled-whitespace-collapse",
    caught: true,
    code: String.raw`  const collapsed = text.replace(/\s+/g, ' ').trim();`,
  },
  {
    // Why the rule is `scope: "chain"`: `oxfmt` splits a long call, and a line
    // rule then matches nothing while `pnpm check` still exits 0.
    name: "hand-rolled-whitespace-collapse — the call the formatter split across lines",
    rule: "hand-rolled-whitespace-collapse",
    caught: true,
    code: String.raw`  const collapsed = text
    .replace(
      /\s+/g,
      " ",
    )
    .trim();`,
  },
  {
    name: "hand-rolled-whitespace-collapse — the adjacent split/join spelling of the same fold",
    rule: "hand-rolled-whitespace-collapse",
    caught: true,
    code: String.raw`  const collapsed = text.split(/\s+/).join(" ").trim();`,
  },
  {
    // `matchChains` blanks comment lines but keeps their byte offsets, so a
    // comment inside the chain must not break the adjacency the rule uses to
    // tell a fold from a tokenizer.
    name: "hand-rolled-whitespace-collapse — a comment inside the chain does not hide it",
    rule: "hand-rolled-whitespace-collapse",
    caught: true,
    code: String.raw`  const collapsed = text
    .split(/\s+/)
    // one token per word
    .join(" ");`,
  },
  {
    name: "hand-rolled-whitespace-collapse — folding to EMPTY is a length measure, not this fold",
    caught: false,
    code: String.raw`  if (out.text.replace(/\s+/g, "").length < MIN_READABLE_CHARS) return null;`,
  },
  {
    name: "hand-rolled-whitespace-collapse — pack.ts's narrow line-terminator fold is a different job",
    caught: false,
    code: String.raw`    .replace(/[\r\n  ]+/g, " ")`,
  },
  {
    // Also the proof that widening to `{2,}` stayed narrow: the quantifier is
    // the same, the class is not `\s`, so the row still ignores it.
    name: "hand-rolled-whitespace-collapse — pack.ts's space/tab run is a different job too",
    caught: false,
    code: String.raw`    .replace(/[ \t]{2,}/g, " ")`,
  },
  {
    name: "hand-rolled-whitespace-collapse — a query-grammar fold is not a whitespace run",
    caught: false,
    code: String.raw`      .replace(/\(\s*(?:AND|OR)\s+/g, "(")`,
  },
  {
    name: "hand-rolled-whitespace-collapse — collapsing the space before a newline keeps the newline",
    caught: false,
    code: String.raw`    .replace(/\s+\n/g, "\n")`,
  },
  {
    // The distant `.join(` a tokenizer never writes. Chasing it is what would
    // manufacture a false positive on `loop-key.ts`'s token split.
    name: "hand-rolled-whitespace-collapse — a tokenizer split with no join is not a fold",
    caught: false,
    code: String.raw`  const tokens = normalized.split(/\s+/).filter(Boolean);`,
  },
  {
    name: "hand-rolled-whitespace-collapse — a knowledge owner keeps its non-display fold",
    caught: false,
    code: String.raw`  const collapsed = content.replace(/\s+/g, " ").trim();`,
    file: KNOWLEDGE_OWNER_FILE,
  },
  {
    // `hand-rolled-enum-guard` fences the `(TUPLE as readonly string[]).includes`
    // boilerplate `enumGuard` owns. `lanes: "all"` because the row is a hint.
    name: "hand-rolled-enum-guard — the cast-plus-includes membership test",
    rule: "hand-rolled-enum-guard",
    lanes: "all",
    caught: true,
    file: "packages/contracts/src/event-triggers.ts",
    code: `  return (EVENT_SOURCE_ENTRIES[source].eventTypes as readonly string[]).includes(value);`,
  },
  {
    name: "hand-rolled-enum-guard — the formatter-split cast still matches (why the rule is chain scope)",
    rule: "hand-rolled-enum-guard",
    lanes: "all",
    caught: true,
    code: `  return (EVENT_TYPES as readonly string[])
    .includes(value);`,
  },
  {
    name: "hand-rolled-enum-guard — the guard built once with enumGuard is the intended form",
    lanes: "all",
    caught: false,
    code: `  if (!isTruncationCauseKind(kind)) continue;`,
  },
  {
    name: "hand-rolled-enum-guard — a z.enum over the tuple is a declaration, not a membership test",
    lanes: "all",
    caught: false,
    code: `    reason: z.enum(GMAIL_MESSAGE_EVENT_REASONS).optional(),`,
  },
  {
    // The documented residue, locked: a cast stored to a binding chapters
    // before the `.includes` is two statements, outside any sound span.
    name: "hand-rolled-enum-guard — a cast bound chapters before its includes is outside the span",
    lanes: "all",
    caught: false,
    code: `  const windowValues = CALENDAR_WINDOW_VALUES as readonly string[];`,
  },
  {
    // `object-keys-cast` points a key cast at the typed helpers in
    // packages/contracts/src/records.ts. `lanes: "all"` because the row is a hint.
    name: "object-keys-cast — Object.keys of a const table asserted to its key union",
    rule: "object-keys-cast",
    lanes: "all",
    caught: true,
    code: `  for (const key of Object.keys(providerRegistry) as (keyof ProviderRegistry)[]) {`,
  },
  {
    name: "object-keys-cast — a formatter-split fromEntries keeps its cast in reach (why the rule is chain scope)",
    rule: "object-keys-cast",
    lanes: "all",
    caught: true,
    code: `  Object.fromEntries(
    SUPPORTED_PASSTHROUGH_SLUGS.map((slug) => [slug, passthroughPreferenceKey(slug)]),
  ) as Record<SupportedPassthroughSlug, string>;`,
  },
  {
    name: "object-keys-cast — Object.keys with no cast reads string keys, which is honest",
    lanes: "all",
    caught: false,
    code: `    for (const field of Object.keys(data.increment)) {`,
  },
  {
    name: "object-keys-cast — the helper call is the intended form",
    lanes: "all",
    caught: false,
    code: `export const INTEGRATION_SLUGS: readonly IntegrationSlug[] = typedKeys(INTEGRATIONS);`,
  },
  {
    // `raw-gmail-token-call` fences the token-taking Gmail calls inside the
    // integrations package. The namespace and dynamic spellings name no call,
    // so they reached every one of them before the specifier branch existed.
    name: "raw-gmail-token-call — a named import of a token call",
    caught: true,
    rule: "raw-gmail-token-call",
    file: GMAIL_SIBLING_FILE,
    code: `import {
  extractMessageContent,
  listMessages,
} from "./gmail";`,
  },
  {
    name: "raw-gmail-token-call — a namespace import reaches every token call",
    caught: true,
    rule: "raw-gmail-token-call",
    file: GMAIL_SIBLING_FILE,
    code: `import * as gmail from "./gmail";`,
  },
  {
    name: "raw-gmail-token-call — a bare export * re-opens the door",
    caught: true,
    rule: "raw-gmail-token-call",
    file: "packages/integrations/src/google/index.ts",
    code: `export * from "./gmail";`,
  },
  {
    name: "raw-gmail-token-call — a namespace re-export",
    caught: true,
    rule: "raw-gmail-token-call",
    file: "packages/integrations/src/google/index.ts",
    code: `export * as gmail from "./gmail";`,
  },
  {
    name: "raw-gmail-token-call — a specifier with a .ts extension",
    caught: true,
    rule: "raw-gmail-token-call",
    file: "packages/integrations/src/index.ts",
    code: `import { sendMessage } from "./google/gmail.ts";`,
  },
  {
    name: "raw-gmail-token-call — a dynamic import",
    caught: true,
    rule: "raw-gmail-token-call",
    file: GMAIL_SIBLING_FILE,
    code: `const gmail = await import("./gmail.js");`,
  },
  {
    name: "raw-gmail-token-call — the pure parsers re-exported from the barrel",
    caught: false,
    file: "packages/integrations/src/google/index.ts",
    code: `export {
  extractAttachments,
  extractMessageContent,
  extractMessageHtml,
  isHistoryGoneError,
} from "./gmail";`,
  },
  {
    name: "raw-gmail-token-call — type-only imports of the argument shapes",
    caught: false,
    file: GMAIL_SIBLING_FILE,
    code: `import type { GetMessageArgs, GmailMessage, SendMessageArgs } from "./gmail";`,
  },
  {
    name: "raw-gmail-token-call — the mailbox is the sanctioned door",
    caught: false,
    file: GMAIL_SIBLING_FILE,
    code: `import { gmailMailboxFor } from "./mailbox";`,
  },
  {
    name: "raw-gmail-token-call — the assistant's gmail tool module is a different file",
    caught: false,
    file: "packages/assistant/src/tool-runtime/builtin-tools.ts",
    code: `import * as gmail from "./internal/tools/gmail";`,
  },
  {
    name: "raw-gmail-token-call — the owner imports the token calls",
    caught: false,
    file: "packages/integrations/src/google/mailbox.ts",
    code: `import { batchModifyMessages, listMessages } from "./gmail";`,
  },
  {
    // `hand-rolled-domain-match` — the variable-base spelling of "is this the
    // domain or a subdomain". The two-direction form in entity-kind-classifier
    // is the case the backreferences exist for.
    name: "hand-rolled-domain-match — the inline callback, split by the formatter",
    caught: true,
    rule: "hand-rolled-domain-match",
    code: `  return SERVICE_DOMAIN_SUFFIXES.some(
    (suffix) => domain === suffix || domain.endsWith(\`.\${suffix}\`),
  );`,
  },
  {
    name: "hand-rolled-domain-match — the reversed operand order",
    caught: true,
    rule: "hand-rolled-domain-match",
    code: `    candidate === domain || domain.endsWith(\`.\${candidate}\`) || candidate.endsWith(\`.\${domain}\`)`,
  },
  {
    name: "hand-rolled-domain-match — the string-concatenation spelling",
    caught: true,
    rule: "hand-rolled-domain-match",
    code: `  return host === base || host.endsWith("." + base);`,
  },
  {
    name: "hand-rolled-domain-match — a proper-subdomain test has no equality half",
    caught: false,
    code: `  return domain.endsWith(\`.\${suffix}\`);`,
  },
  {
    name: "hand-rolled-domain-match — the helper's own body",
    caught: false,
    file: "packages/contracts/src/domain.ts",
    code: `  return domain === base || domain.endsWith(\`.\${base}\`);`,
  },
  {
    name: "hand-rolled-domain-match — the equality and the suffix test name different values",
    caught: false,
    code: `  return host === base || other.endsWith(\`.\${base}\`);`,
  },
  {
    name: "hand-rolled-domain-literal-match — a written-out host",
    caught: true,
    rule: "hand-rolled-domain-literal-match",
    lanes: "all",
    code: `  return domain === "sentry.io" || domain.endsWith(".sentry.io");`,
  },
  {
    name: "hand-rolled-domain-literal-match — a different host on each side",
    caught: false,
    lanes: "all",
    code: `  return domain === "stripe.email" || domain.endsWith(".stripe.com");`,
  },
  {
    // `error-to-message` — the caught-error fold `toMessage` replaced (30d7e067).
    name: "error-to-message — the one-line fold",
    caught: true,
    rule: "error-to-message",
    code: `  return err instanceof Error ? err.message : String(err);`,
  },
  {
    // Why the rule is `scope: "chain"`: the formatter breaks a long ternary.
    name: "error-to-message — the ternary the formatter split across lines",
    caught: true,
    rule: "error-to-message",
    code: `    const message =
      error instanceof Error
        ? error.message
        : String(error);`,
  },
  {
    name: "error-to-message — the stack-preferring variant is a different call",
    caught: false,
    code: `  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);`,
  },
  {
    name: "error-to-message — a domain-specific fallback is a different call",
    caught: false,
    code: `  const reason = err instanceof Error ? err.message : "Invalid JSON";`,
  },
  {
    name: "error-to-message — the helper's own body",
    caught: false,
    file: "packages/contracts/src/errors.ts",
    code: `  return err instanceof Error ? err.message : String(err);`,
  },
  {
    // `spread-over-defaults` — the defaults merges `withDefaults` replaced (f5c88a44).
    name: "spread-over-defaults — a SCREAMING_CASE defaults object under the overrides",
    caught: true,
    rule: "spread-over-defaults",
    code: `  const d: ReconcileThreadLabelDeps = { ...DEFAULT_DEPS, ...deps };`,
  },
  {
    name: "spread-over-defaults — a defaultFoo object under the overrides",
    caught: true,
    rule: "spread-over-defaults",
    code: `  const guardDeps = { ...defaultGuardUnreportedToolFailuresDeps, ...deps };`,
  },
  {
    // Why the rule is `scope: "chain"`: a long literal puts each spread on its own line.
    name: "spread-over-defaults — the literal the formatter split across lines",
    caught: true,
    rule: "spread-over-defaults",
    code: `  const options = {
    ...DEFAULT_RETRY_OPTIONS,
    ...overrides,
  };`,
  },
  {
    name: "spread-over-defaults — an overlay of two inputs is not defaults resolution",
    caught: false,
    code: `  const payload = { ...input, ...sanitized };`,
  },
  {
    name: "spread-over-defaults — withDefaults is the intended form",
    caught: false,
    code: `  const d = withDefaults(DEFAULT_DEPS, deps);`,
  },
];

// Line-scope fixtures. `boot-error-plain-extends` is a per-line rule, so it is
// invisible to `matchChains` (which only runs `scope: "chain"` rules) — the
// self-test would silently never watch it fire. `selfTestFailures` runs these
// through `matchLine`, the same door `pnpm check` uses for line rules.

/** A source file the line rules are not exempt in. */
const LINE_FILE = "packages/assistant/src/connections/ingestion/chat-media.ts";

/**
 * A file inside the object-state module. `object-state-row-lock-mode` names its
 * own `paths`, so the file a fixture claims to be is part of the answer, not
 * scenery — {@link LINE_FILE} sits in the same package and must NOT match.
 */
const OBJECT_STATE_FILE = "packages/assistant/src/connections/object-state/store.ts";

/** A production web file. The design-token gates name their own `paths`. */
const WEB_APP_FILE = "apps/web/src/lib/shell/app-sidebar/thread-content.tsx";

/** A landing-page file, which keeps the dimension grammar on purpose. */
const WEB_LANDING_FILE = "apps/web/src/components/landing/hero-band.tsx";

/**
 * @type {{name: string, caught: boolean, code: string, file?: string, rule?: string, lanes?: "gate"|"all"}[]} `file`
 *   defaults to {@link LINE_FILE}, as in {@link CASES}.
 */
const LINE_CASES = [
  {
    // `email-domain-split` — the github-adapter and loop-key spelling that
    // parseMailbox replaced. `[0]` (a local-part display fallback) is not drift.
    name: "email-domain-split — the domain after the first @",
    caught: true,
    rule: "email-domain-split",
    code: `  if (address) parts.push(address, address.split("@")[1] ?? "");`,
  },
  {
    name: "email-domain-split — the local part is not the domain",
    caught: false,
    code: `  if (user.email) return user.email.split("@")[0] ?? "";`,
  },
  {
    name: "module-scope-settings-bind — a bind held at module scope",
    caught: true,
    rule: "module-scope-settings-bind",
    code: `const ownerSettings = settings({ userId: OWNER_ID });`,
  },
  {
    name: "module-scope-settings-bind — an exported, typed module-scope bind",
    caught: true,
    rule: "module-scope-settings-bind",
    code: `export const ownerSettings: UserSettings = settings({ userId });`,
  },
  {
    name: "module-scope-settings-bind — a bind inside a function body is the intended form",
    caught: false,
    code: `  const userSettings = settings({ userId: ctx.userId });`,
  },
  {
    name: "module-scope-settings-bind — a one-shot read through a fresh bind",
    caught: false,
    code: `const prefs = await resolveBriefingPreferences(settings({ userId }));`,
  },
  {
    name: "boot-error-plain-extends — a No…RegisteredError left on plain Error",
    caught: true,
    rule: "boot-error-plain-extends",
    code: `export class NoFooHandlerRegisteredError extends Error {`,
  },
  {
    name: "already a TriggerConsumerBootError member — the intended form",
    caught: false,
    code: `export class NoFooHandlerRegisteredError extends TriggerConsumerBootError {`,
  },
  {
    name: "the base class itself never self-matches",
    caught: false,
    code: `export abstract class TriggerConsumerBootError extends Error {`,
  },
  {
    name: "an unrelated *NotFound* error extending Error is not a registry boot error",
    caught: false,
    code: `export class GoogleCredentialNotFoundError extends Error {`,
  },
  {
    name: "partial-integration-slug-record — a sparse slug-keyed table (the PR #943 shape)",
    caught: true,
    rule: "partial-integration-slug-record",
    code: `const BRAND_BY_SLUG = { gmail: "gmail" } satisfies Partial<Record<IntegrationSlug, string>>;`,
  },
  {
    name: "partial-integration-slug-record — a Map from a catalog id to a loadable slug",
    caught: true,
    rule: "partial-integration-slug-record",
    code: `const PROVIDER_ID_TO_SLUG = new Map<string, LoadableIntegrationSlug>([`,
  },
  {
    name: "partial-integration-slug-record — a Partial over a derived live-provider union",
    caught: true,
    rule: "partial-integration-slug-record",
    code: `const PAGE_BY_SLUG: Partial<Record<LiveProviderSlug, string>> = {};`,
  },
  {
    name: "partial-integration-slug-record — a Partial over the catalog union",
    caught: true,
    rule: "partial-integration-slug-record",
    code: `const ACCENT = { github: "#181925" } satisfies Partial<Record<CatalogSlug, string>>;`,
  },
  {
    name: "partial-integration-slug-record — a Partial over the transition passthrough alias",
    caught: true,
    rule: "partial-integration-slug-record",
    code: `const GATE: Partial<Record<SupportedIntegrationSlug, boolean>> = {};`,
  },
  {
    name: "partial-integration-slug-record — a Partial over the credential-provider union",
    caught: true,
    rule: "partial-integration-slug-record",
    code: `const FACTORY: Partial<Record<CredentialProvider, ProviderFactory>> = {};`,
  },
  {
    name: "partial-integration-slug-record — a literal Map from a catalog id to a live-provider slug",
    caught: true,
    rule: "partial-integration-slug-record",
    code: `const ID_TO_SLUG = new Map<string, LiveProviderSlug>([["google_gmail", "gmail"]]);`,
  },
  {
    name: "partial-integration-slug-record — a literal Map keyed by a loadable slug",
    caught: true,
    rule: "partial-integration-slug-record",
    code: `const LABEL = new Map<LoadableIntegrationSlug, string>([["gmail", "Mail"]]);`,
  },
  {
    name: "partial-integration-slug-record — a literal Map keyed by the slug with a generic value",
    caught: true,
    rule: "partial-integration-slug-record",
    code: `const GLYPH_FALLBACK = new Map<IntegrationSlug, LucideIcon>([`,
  },
  {
    name: "a Map keyed by a slug and filled at request time is a lookup index, not a table",
    caught: false,
    code: `const availability = new Map<LoadableIntegrationSlug, IntegrationAvailability>();`,
  },
  {
    name: "a briefing gather source is not an integration slug",
    caught: false,
    code: `const SOURCE_BRAND = new Map<GatherSourceSlug, IntegrationBrand>([`,
  },
  {
    name: "an exhaustive slug-keyed table is the intended form",
    caught: false,
    code: `} as const satisfies Record<IntegrationSlug, string>;`,
  },
  {
    name: "a partial record keyed by something other than a slug is not this rule's business",
    caught: false,
    code: `  toolOverrides?: Partial<Record<ToolName, PolicyMode>>;`,
  },
  {
    // ADR-0094 rests on one constant. This fixture is the only thing that
    // proves the guard watches it, so the ADR's "no failing check" gap is
    // closed rather than merely asserted.
    name: "read-write-github-mcp-endpoint — the `/mcp` root this branch moved away from",
    caught: true,
    rule: "read-write-github-mcp-endpoint",
    code: `export const GITHUB_MCP_ENDPOINT_HREF = "https://api.githubcopilot.com/mcp" as const;`,
  },
  {
    name: "read-write-github-mcp-endpoint — a trailing slash does not make the root read-only",
    caught: true,
    rule: "read-write-github-mcp-endpoint",
    code: `const endpoint = new URL("https://api.githubcopilot.com/mcp/");`,
  },
  {
    // The guard reads code, not prose: `matchLine` skips comment-only lines so a
    // doc example of a banned idiom is not drift. So this rule cannot keep a
    // docstring honest, and it never sees `.env.example` or a `.sql` migration
    // either — the drift scanner takes `*.ts` / `*.tsx` only.
    name: "read-write-github-mcp-endpoint — a comment naming the root is out of the guard's reach",
    caught: false,
    code: ` * Falls back to https://api.githubcopilot.com/mcp when the pin is absent.`,
  },
  {
    name: "read-write-github-mcp-endpoint — the pinned read-only resource is the intended form",
    caught: false,
    code: `export const GITHUB_MCP_ENDPOINT_HREF = "https://api.githubcopilot.com/mcp/readonly" as const;`,
  },
  {
    name: "read-write-github-mcp-endpoint — another origin serving /mcp is not GitHub's write catalog",
    caught: false,
    code: `assert.equal(resolveBuiltInClient(new URL("https://evil.example.test/mcp")), undefined);`,
  },
  {
    // `object-state-row-lock-mode` names its own `paths`, so the file is part of
    // the answer. A rule whose path regex missed the directory would scan zero
    // files and still report "no drift" — these three fix that in both
    // directions: it fires inside, stays quiet on the intended mode, and stays
    // quiet on the ~30 `.for("update")` sites elsewhere in the same package.
    name: "object-state-row-lock-mode — FOR UPDATE on an object-state row re-opens the cross-table cycle",
    caught: true,
    rule: "object-state-row-lock-mode",
    code: `      .for("update")`,
    file: OBJECT_STATE_FILE,
  },
  {
    name: "object-state-row-lock-mode — the weaker mode the FK check needs is the intended form",
    caught: false,
    code: `      .for("no key update")`,
    file: OBJECT_STATE_FILE,
  },
  {
    name: "object-state-row-lock-mode — FOR UPDATE outside the module stays the package's idiom",
    caught: false,
    code: `      .for("update")`,
  },
  {
    // `raw-radius-class` names its own `paths`. These fix it in both
    // directions: a t-shirt size, an arbitrary px value, and a variant-prefixed
    // side class fire in the app; the role tiers and the shape classes stay
    // quiet; and the same raw class on the landing page stays quiet.
    name: "raw-radius-class — a t-shirt radius on a thread row is a local guess",
    caught: true,
    rule: "raw-radius-class",
    code: `          "inline-flex h-9 w-full items-center gap-2 rounded-xl pr-2 pl-3 text-left",`,
    file: WEB_APP_FILE,
  },
  {
    name: "raw-radius-class — an arbitrary px radius is a local guess",
    caught: true,
    rule: "raw-radius-class",
    code: `  md: "h-8 px-2.5 text-sm gap-2 rounded-[10px]",`,
    file: WEB_APP_FILE,
  },
  {
    name: "raw-radius-class — a variant-prefixed side radius is still raw",
    caught: true,
    rule: "raw-radius-class",
    code: `      className="size-20 sm:rounded-t-3xl"`,
    file: WEB_APP_FILE,
  },
  {
    name: "raw-radius-class — role tiers and shape classes are the intended form",
    caught: false,
    code: `  "rounded-control-sm rounded-t-panel rounded-full rounded-[inherit] rounded-none",`,
    file: WEB_APP_FILE,
  },
  {
    name: "raw-radius-class — the landing page keeps the dimension grammar",
    caught: false,
    code: `          "inline-flex h-9 w-full items-center gap-2 rounded-xl pr-2 pl-3 text-left",`,
    file: WEB_LANDING_FILE,
  },
  {
    name: "raw-palette-color — a raw Tailwind hue for status text skips the AA token",
    caught: true,
    rule: "raw-palette-color",
    code: `          <p className="mt-1 text-xs text-rose-600">{runNow.error.message}</p>`,
    file: WEB_APP_FILE,
  },
  {
    name: "raw-palette-color — a white-alpha step on media skips the app-media tokens",
    caught: true,
    rule: "raw-palette-color",
    code: `            "text-white/70 hover:bg-white/[0.07] hover:text-white",`,
    file: WEB_APP_FILE,
  },
  {
    name: "raw-palette-color — a variant-prefixed raw hue is still raw",
    caught: true,
    rule: "raw-palette-color",
    code: `        "data-[state=active]:bg-emerald-400/15 dark:text-red-200",`,
    file: WEB_APP_FILE,
  },
  {
    name: "raw-palette-color — app tokens, solid white, and black scrims are the intended form",
    caught: false,
    code: `  "bg-app-red-1 text-app-red-4 ring-app-bg-a3 text-app-fg-a3 bg-white text-white bg-black/70",`,
    file: WEB_APP_FILE,
  },
  {
    name: "raw-palette-color — the landing page keeps the dimension grammar",
    caught: false,
    code: `        "text-white/70 bg-neutral-900 ring-purple-500",`,
    file: WEB_LANDING_FILE,
  },
  {
    name: "replicache-subscribe-outside-helper — a hook writes its own subscription",
    caught: true,
    rule: "replicache-subscribe-outside-helper",
    code: `    const unsubscribe = rep.subscribe(scanTodos, (rows) => setSnapshot({ rep, rows }));`,
    file: WEB_APP_FILE,
  },
  {
    name: "replicache-subscribe-outside-helper — an optional client still subscribes outside the helper",
    caught: true,
    rule: "replicache-subscribe-outside-helper",
    code: `    const unsubscribe = rep?.subscribe(scanTodos, (rows) => setSnapshot({ rep, rows }));`,
    file: WEB_APP_FILE,
  },
  {
    name: "replicache-subscribe-outside-helper — an experimental watch outside the helper",
    caught: true,
    rule: "replicache-subscribe-outside-helper",
    code: `    const unsubscribe = rep.experimentalWatch(scanTodos, (rows) => setSnapshot({ rep, rows }));`,
    file: WEB_APP_FILE,
  },
  {
    name: "replicache-subscribe-outside-helper — another store's subscribe is not Replicache",
    caught: false,
    code: `    return store.subscribe(onChange);`,
    file: WEB_APP_FILE,
  },
  {
    // `unowned-live-confirmation-proof` is the only witness that a caller's
    // `proof` argument is honest. The compiler cannot be one: the argument is
    // a member of a union, and every member typechecks at every site. So the
    // three fixtures below are the whole enforcement — it fires on the false
    // claim, it stays quiet on the honest weaker claim, and it stays quiet in
    // the two files that own the token.
    name: "unowned-live-confirmation-proof — a stored-row reader claiming a live read it never took",
    caught: true,
    rule: "unowned-live-confirmation-proof",
    code: `  return closesOpenAsk(row.provider, row.kind, row.stateCategory, "live_confirmation");`,
  },
  {
    name: "unowned-live-confirmation-proof — the weaker proof a sync reader honestly holds",
    caught: false,
    code: `  return closesOpenAsk(row.provider, row.kind, row.stateCategory, "stored_projection");`,
  },
  {
    name: "unowned-live-confirmation-proof — the one site that takes the read owns the token",
    caught: false,
    code: `      : closesOpenAsk(state.provider, state.kind, live, "live_confirmation");`,
    file: "packages/assistant/src/briefings/gather.ts",
  },
  {
    name: "unowned-live-confirmation-proof — the registry declaring the vocabulary owns it too",
    caught: false,
    code: `export const CLOSURE_PROOFS = ["stored_projection", "live_confirmation"] as const;`,
    file: "packages/contracts/src/integration-objects.ts",
  },
  {
    name: "unowned-live-confirmation-proof — a docstring naming the token is prose, not an assertion",
    caught: false,
    code: ` * declaring \`closesAskFrom: "live_confirmation"\` needs a read taken at the`,
  },
  {
    // `hand-rolled-record-guard` covers both spellings. The negated early-return
    // used to pass silently (errors.ts `causeOf`); the positive narrow is the
    // regression guard on the alternation itself. `lanes: "all"` because the row
    // is a hint — it never fires in the gate lane.
    name: "hand-rolled-record-guard — the negated early-return spelling (the errors.ts:76 escape)",
    caught: true,
    rule: "hand-rolled-record-guard",
    lanes: "all",
    file: "packages/contracts/src/errors.ts",
    code: `  if (typeof data !== "object" || data === null) return undefined;`,
  },
  {
    name: "hand-rolled-record-guard — the positive narrow spelling",
    caught: true,
    rule: "hand-rolled-record-guard",
    lanes: "all",
    code: `  if (typeof payload === "object" && payload !== null) return payload;`,
  },
  {
    name: "hand-rolled-record-guard — the helper's own definition owns the spelling",
    caught: false,
    lanes: "all",
    file: "packages/contracts/src/guards.ts",
    code: `  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;`,
  },
  {
    name: "hand-rolled-record-guard — the backreference pins both halves to one identifier",
    caught: false,
    lanes: "all",
    code: `  if (typeof head !== "object" || prev === null) return head;`,
  },
  {
    // `oauth-state-primitive` keeps the nonce and state primitives private to
    // the handshake. A route that calls one alone accepts a replayed state.
    name: "oauth-state-primitive — a route verifying the state without the handshake",
    caught: true,
    rule: "oauth-state-primitive",
    file: "packages/api/src/modules/integrations/github-app.ts",
    code: `  const signed = verifyOAuthState(query.state);`,
  },
  {
    name: "oauth-state-primitive — a route remembering its own nonce",
    caught: true,
    rule: "oauth-state-primitive",
    file: "packages/api/src/modules/integrations/github-app.ts",
    code: `  await rememberOAuthNonce(nonce, userId);`,
  },
  {
    name: "oauth-state-primitive — the handshake is the intended door",
    caught: false,
    file: "packages/api/src/modules/integrations/github-app.ts",
    code: `  const { state } = await handshake.begin({ userId });`,
  },
  {
    name: "oauth-state-primitive — the module that holds the primitives",
    caught: false,
    file: "packages/assistant/src/connections/oauth-state.ts",
    code: `      const signed = verifyOAuthState(rawState);`,
  },
  {
    // `bullmq-job-timestamp` — the creation time read as a fire time (#1358).
    name: "bullmq-job-timestamp — a scheduler tick dated from the creation time",
    caught: true,
    rule: "bullmq-job-timestamp",
    code: `      return handleTick(new Date(job.timestamp));`,
  },
  {
    name: "bullmq-job-timestamp — a receiver named for the job",
    caught: true,
    rule: "bullmq-job-timestamp",
    code: `  const createdAt = bullJob.timestamp;`,
  },
  {
    name: "bullmq-job-timestamp — the identity fallback for a request id",
    caught: false,
    code: "        requestId: `memory-job:${job.id ?? job.timestamp}`,",
  },
  {
    name: "bullmq-job-timestamp — a timestamp on a value that is not a job",
    caught: false,
    code: "  return sql`(${effectiveAt}, ${id}) > (${new Date(key.timestamp)}, ${key.invocationId})`;",
  },
  {
    name: "bullmq-job-timestamp — the helper reads it, and owns it",
    caught: false,
    file: "packages/assistant/src/execution/job-scheduler.ts",
    code: `  return new Date(job.timestamp + (job.opts.delay ?? 0));`,
  },
  {
    // `sender-regex-test` — a regex literal over the raw sender (#1360).
    name: "sender-regex-test — the Railway matcher before #1360",
    caught: true,
    rule: "sender-regex-test",
    lanes: "all",
    code: String.raw`  return /railway\.(app|com)/i.test(from ?? "");`,
  },
  {
    name: "sender-regex-test — a property chain ending in the sender",
    caught: true,
    rule: "sender-regex-test",
    lanes: "all",
    code: String.raw`  if (/@vercel\.com>?$/.test(email.senderAddress)) return "vercel";`,
  },
  {
    name: "sender-regex-test — a named sender constant is not a literal",
    caught: false,
    lanes: "all",
    code: `  return GITHUB_NOTIFICATION_RE.test(sender ?? "");`,
  },
  {
    name: "sender-regex-test — a date field ending in From is not a sender",
    caught: false,
    lanes: "all",
    code: String.raw`  if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) return null;`,
  },
  {
    // `humanize-integration-slug` — the tool-catalog title 81f046df replaced.
    name: "humanize-integration-slug — a tool's integration title-cased",
    caught: true,
    rule: "humanize-integration-slug",
    code: `  const name = humanizeSlug(tool.integration);`,
  },
  {
    name: "humanize-integration-slug — the same value under its longer name",
    caught: true,
    rule: "humanize-integration-slug",
    code: "  const label = `${humanizeSlug(row.integrationSlug)} account`;",
  },
  {
    // The credential-provider fallback label #1367 replaced (readiness.ts).
    name: "humanize-integration-slug — a credential provider title-cased",
    caught: true,
    rule: "humanize-integration-slug",
    code: "      accountLabel: row?.accountLabel ?? `${humanizeSlug(provider)} account`,",
  },
  {
    // The event-source messages #1367 replaced (readiness.ts).
    name: "humanize-integration-slug — an event-trigger source as a property",
    caught: true,
    rule: "humanize-integration-slug",
    code: "      message: `Choose the connected account for the ${humanizeSlug(trigger.source)} trigger.`,",
  },
  {
    name: "humanize-integration-slug — a bare event source",
    caught: true,
    rule: "humanize-integration-slug",
    code: '    message: `${humanizeSlug(source)} event delivery is ${notReady ? "not ready" : "degraded"}.`,',
  },
  {
    // The MCP identity-provider option label (mcp-health-mapping.tsx).
    name: "humanize-integration-slug — a camel-suffixed provider",
    caught: true,
    rule: "humanize-integration-slug",
    code: `  const label = humanizeSlug(row.identityProvider);`,
  },
  {
    name: "humanize-integration-slug — a provider record's slug field",
    caught: true,
    rule: "humanize-integration-slug",
    code: `  const name = humanizeSlug(provider.slug);`,
  },
  {
    name: "humanize-integration-slug — a provider read through an optional chain",
    caught: true,
    rule: "humanize-integration-slug",
    code: "  const label = `${humanizeSlug(row?.provider)} account`;",
  },
  {
    name: "humanize-integration-slug — a provider record's slug through an optional chain",
    caught: true,
    rule: "humanize-integration-slug",
    code: `  const name = humanizeSlug(provider?.slug);`,
  },
  {
    name: "humanize-integration-slug — a source's kind through an optional chain is a kind slug",
    caught: false,
    code: `  const label = humanizeSlug(source?.kind);`,
  },
  {
    name: "humanize-integration-slug — an action slug is what humanizeSlug is for",
    caught: false,
    code: `    title: overrides.title ?? humanizeSlug(input.action),`,
  },
  {
    name: "humanize-integration-slug — an action read off an integration-shaped object",
    caught: false,
    code: `  const verb = humanizeSlug(integration.action);`,
  },
  {
    name: "humanize-integration-slug — a source's kind is a kind slug",
    caught: false,
    code: `  const label = humanizeSlug(source.kind);`,
  },
  {
    name: "humanize-integration-slug — state, key and resource are not integration names",
    caught: false,
    code: `  const parts = [humanizeSlug(state), humanizeSlug(key), humanizeSlug(resource)];`,
  },
  {
    name: "humanize-integration-slug — the display-name reader is the intended form",
    caught: false,
    code: "    ? `${humanizeSlug(action)} in ${integrationDisplayName(integration)}`",
  },
  {
    // `hand-rolled-key-guard` fences the membership body `keyGuard` owns.
    name: "hand-rolled-key-guard — Object.hasOwn over a SCREAMING_CASE table",
    caught: true,
    rule: "hand-rolled-key-guard",
    code: `  return Object.hasOwn(SENDER_WORDS, value);`,
  },
  {
    name: "hand-rolled-key-guard — the prototype hasOwnProperty spelling of the same test",
    caught: true,
    rule: "hand-rolled-key-guard",
    code: `  return Object.prototype.hasOwnProperty.call(FACT_ONTOLOGY, key);`,
  },
  {
    name: "hand-rolled-key-guard — the guard built once with keyGuard is the intended form",
    caught: false,
    code: `export const isFactKey = keyGuard(FACT_ONTOLOGY);`,
  },
  {
    // The documented residue, locked: a lowercase table name is outside the regex.
    name: "hand-rolled-key-guard — a lowercase table name is outside the regex",
    caught: false,
    code: `  return Object.prototype.hasOwnProperty.call(serverMutators, name);`,
  },
  {
    // `as-string-array` — the unchecked element-type assertion.
    name: "as-string-array — an unknown value asserted to a string array",
    caught: true,
    rule: "as-string-array",
    code: `  const labels = payload.labels as string[];`,
  },
  {
    name: "as-string-array — the generic spelling of the same assertion",
    caught: true,
    rule: "as-string-array",
    code: `  const labels = payload.labels as ReadonlyArray<string>;`,
  },
  {
    name: "as-string-array — a union assertion is a different, narrower shape",
    caught: false,
    code: `  const labels = payload.labels as string[] | undefined;`,
  },
  {
    name: "as-string-array — the readonly widening cast belongs to hand-rolled-enum-guard",
    caught: false,
    code: `  return (EVENT_TYPES as readonly string[]).includes(value);`,
  },
  {
    name: "as-string-array — the guard module owns the assertion",
    caught: false,
    file: "packages/contracts/src/guards.ts",
    code: `  return value as string[];`,
  },
  {
    // `sql-any-of-interpolated-list` — the briefing alias read 1395cb95 fixed.
    name: "sql-any-of-interpolated-list — the sender-significance alias read",
    caught: true,
    rule: "sql-any-of-interpolated-list",
    code: "            WHERE lower(alias) = ANY(${targetList})",
  },
  {
    name: "sql-any-of-interpolated-list — lower-case SQL with a space before the paren",
    caught: true,
    rule: "sql-any-of-interpolated-list",
    code: "      AND id = any (${ids})",
  },
  {
    // The second form the row's own fix names. It binds ONE array parameter,
    // so it is the cure, and the regex once flagged it.
    name: "sql-any-of-interpolated-list — one array parameter with a cast is the intended form",
    caught: false,
    code: "            WHERE lower(alias) = ANY(${sql.param(targetList)}::text[])",
  },
  {
    name: "sql-any-of-interpolated-list — inArray inside the template is the intended form",
    caught: false,
    code: "            WHERE ${inArray(sql`lower(alias)`, targetList)}",
  },
  {
    // `canonical-param-key` — the key fold 052cc8cf replaced.
    name: "canonical-param-key — the hand-rolled key fold",
    caught: true,
    rule: "canonical-param-key",
    code: `const canon = (key: string): string => key.toLowerCase().replace(/[_-]/g, "");`,
  },
  {
    name: "canonical-param-key — the class in the other order, through replaceAll",
    caught: true,
    rule: "canonical-param-key",
    code: `  const folded = key.toLowerCase().replaceAll(/[-_]/g, "");`,
  },
  {
    name: "canonical-param-key — folding separators to a space is a label, not a key",
    caught: false,
    code: `  const label = key.toLowerCase().replace(/[_-]/g, " ");`,
  },
  {
    name: "canonical-param-key — the helper's own module",
    caught: false,
    file: "packages/contracts/src/tool-schemas.ts",
    code: `  return key.toLowerCase().replace(/[_-]/g, "");`,
  },
  {
    // `hand-split-oauth-scope` — the two grammars 7b2d6a42 merged.
    name: "hand-split-oauth-scope — the GitHub App's comma-and-space split",
    caught: true,
    rule: "hand-split-oauth-scope",
    code: String.raw`    scopes: parsed.data.scope ? parsed.data.scope.split(/[,\s]+/).filter(Boolean) : [],`,
  },
  {
    name: "hand-split-oauth-scope — the MCP provider's whitespace-only split",
    caught: true,
    rule: "hand-split-oauth-scope",
    code: String.raw`  return scope?.split(/\s+/).filter(Boolean) ?? [];`,
  },
  {
    name: "hand-split-oauth-scope — a prefixed identifier",
    caught: true,
    rule: "hand-split-oauth-scope",
    code: `  const granted = grantedScopes.split(",");`,
  },
  {
    name: "hand-split-oauth-scope — the one grammar is the intended form",
    caught: false,
    code: `    scopes: parseOAuthScopeList(parsed.data.scope),`,
  },
  {
    name: "hand-split-oauth-scope — the grammar's own module",
    caught: false,
    file: "packages/contracts/src/oauth-scopes.ts",
    code: String.raw`  return scope.split(/[,\s]+/).filter(Boolean);`,
  },
  {
    // `hand-rolled-timezone-validator` — the Intl trial 7d2df21f deleted from
    // web, sync and api.
    name: "hand-rolled-timezone-validator — the copied function declaration",
    caught: true,
    rule: "hand-rolled-timezone-validator",
    code: `function isValidTimezone(tz: string): boolean {`,
  },
  {
    name: "hand-rolled-timezone-validator — an arrow under Intl's own casing",
    caught: true,
    rule: "hand-rolled-timezone-validator",
    code: `export const isValidTimeZone = (tz: string): boolean => {`,
  },
  {
    name: "hand-rolled-timezone-validator — an alias of the shared validator is not a trial",
    caught: false,
    file: "packages/assistant/src/time/user-timezone.ts",
    code: `export const isValidTimezone = isIanaTimezone;`,
  },
  {
    name: "hand-rolled-timezone-validator — calling the shared validator",
    caught: false,
    code: `  if (!isIanaTimezone(tz)) return null;`,
  },
  {
    // `as-tool-name` — the casts 514702ef removed.
    name: "as-tool-name — a string asserted to a tool name",
    caught: true,
    rule: "as-tool-name",
    code: `    const toolName = "system.fetch_url" as ToolName;`,
  },
  {
    name: "as-tool-name — narrowing with isToolName is the intended form",
    caught: false,
    code: `  if (!isToolName(name)) return undefined;`,
  },
  {
    name: "as-tool-name — a test fixture is outside the gate's path filter",
    caught: false,
    file: TEST_TREE_FILE,
    code: `    const toolName = "system.fetch_url" as ToolName;`,
  },
  {
    // `raw-process-env` — the env invariant.
    name: "raw-process-env — a direct read of the process env",
    caught: true,
    rule: "raw-process-env",
    code: `  const apiKey = process.env.ANTHROPIC_API_KEY;`,
  },
  {
    name: "raw-process-env — a named env import reads the same object",
    caught: true,
    rule: "raw-process-env",
    code: `import { env } from "node:process";`,
  },
  {
    name: "raw-process-env — serverEnv() is the intended form",
    caught: false,
    code: `  const { ANTHROPIC_API_KEY } = serverEnv();`,
  },
  {
    name: "raw-process-env — the env package's own schema reader",
    caught: false,
    file: "packages/env/src/server.ts",
    code: `  const parsed = serverSchema.safeParse(process.env);`,
  },
  {
    name: "raw-process-env — a test tree is outside the gate's path filter",
    caught: false,
    file: TEST_TREE_FILE,
    code: `  const apiKey = process.env.ANTHROPIC_API_KEY;`,
  },
  {
    // `hand-built-api-error` — the subclasses f8ac8ba2 collapsed into `Errors`.
    name: "hand-built-api-error — a per-kind subclass",
    caught: true,
    rule: "hand-built-api-error",
    code: `export class NotFoundError extends ApiError {`,
  },
  {
    name: "hand-built-api-error — a direct construction pairing a code by hand",
    caught: true,
    rule: "hand-built-api-error",
    code: '  throw new ApiError("NOT_FOUND", `Run ${id} not found`);',
  },
  {
    name: "hand-built-api-error — an Errors factory is the intended form",
    caught: false,
    code: `  throw Errors.NotFoundError("Run not found");`,
  },
  {
    name: "hand-built-api-error — catching by code is the intended form",
    caught: false,
    code: `  if (isApiError(err, "NOT_FOUND")) return null;`,
  },
  {
    name: "hand-built-api-error — the module that owns the class",
    caught: false,
    file: "packages/contracts/src/api-errors.ts",
    code: `    return new ApiError(code, message);`,
  },
  {
    // `hand-rolled-utc-offset-parse` — the copies 44b9ee85 and a0b11b12 folded
    // into `inZone(tz).offsetMs`.
    name: "hand-rolled-utc-offset-parse — a second longOffset formatter",
    caught: true,
    rule: "hand-rolled-utc-offset-parse",
    code: `      timeZoneName: "longOffset",`,
  },
  {
    name: "hand-rolled-utc-offset-parse — a second GMT offset parse",
    caught: true,
    rule: "hand-rolled-utc-offset-parse",
    code: String.raw`  const match = /^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?)?$/.exec(value);`,
  },
  {
    name: "hand-rolled-utc-offset-parse — the one reader owns the parse",
    caught: false,
    file: "packages/assistant/src/time/local-time.ts",
    code: `      timeZoneName: "longOffset",`,
  },
  {
    // `briefing-schedule-section.tsx` renders this label and never reads a
    // number out of it, so it is a display, not a second offset answer.
    name: "hand-rolled-utc-offset-parse — a shortOffset display label is not a parse",
    caught: false,
    file: "apps/web/src/routes/-settings/briefing-schedule-section.tsx",
    code: `      timeZoneName: "shortOffset",`,
  },
  {
    // `raw-ioredis-construction` — the hand-built clients 2b31a2c1 removed.
    name: "raw-ioredis-construction — a hand-built client under the IORedis import",
    caught: true,
    rule: "raw-ioredis-construction",
    code: `  const conn = new IORedis(url, {`,
  },
  {
    name: "raw-ioredis-construction — the docs' Redis spelling",
    caught: true,
    rule: "raw-ioredis-construction",
    code: `  const conn = new Redis(url);`,
  },
  {
    name: "raw-ioredis-construction — a hand-built cluster client",
    caught: true,
    rule: "raw-ioredis-construction",
    code: `  const cluster = new Redis.Cluster(nodes);`,
  },
  {
    name: "raw-ioredis-construction — createRedisConnection is the intended form",
    caught: false,
    code: `  const conn = createRedisConnection("queue");`,
  },
  {
    name: "raw-ioredis-construction — the one door owns the constructor",
    caught: false,
    file: "packages/db/src/redis.ts",
    code: `  return new IORedis(url, {`,
  },
  {
    name: "suppression-without-reason — a bare next-line directive",
    caught: true,
    rule: "suppression-without-reason",
    code: `  // oxlint-disable-next-line`,
  },
  {
    name: "suppression-without-reason — a named rule with no reason",
    caught: true,
    rule: "suppression-without-reason",
    code: `  // oxlint-disable-next-line anti-slop/no-runtime-typeof`,
  },
  {
    name: "suppression-without-reason — a block directive with no reason, in a test tree",
    caught: true,
    rule: "suppression-without-reason",
    file: TEST_TREE_FILE,
    code: `  /* eslint-disable anti-slop/no-chained-type-assertions */`,
  },
  {
    name: "suppression-without-reason — a bare file-level block directive in a script",
    caught: true,
    rule: "suppression-without-reason",
    file: "scripts/check-oxlint-config.mjs",
    code: `/* eslint-disable */`,
  },
  {
    name: "suppression-without-reason — a reason with no rule name",
    caught: true,
    rule: "suppression-without-reason",
    code: `  // eslint-disable-line -- the fixture needs it`,
  },
  {
    name: "suppression-without-reason — an empty reason after the separator",
    caught: true,
    rule: "suppression-without-reason",
    code: `  // oxlint-disable-next-line typescript/switch-exhaustiveness-check --`,
  },
  {
    name: "suppression-without-reason — two rules and a reason is the intended form",
    caught: false,
    code: `  // oxlint-disable-next-line anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns -- the parse IS the boundary`,
  },
  {
    name: "suppression-without-reason — a block directive with a reason",
    caught: false,
    file: TEST_TREE_FILE,
    code: `  /* eslint-disable anti-slop/no-chained-type-assertions -- a stub stands in for the client */`,
  },
  {
    name: "suppression-without-reason — eslint-enable takes no reason",
    caught: false,
    file: TEST_TREE_FILE,
    code: `  /* eslint-enable anti-slop/no-chained-type-assertions */`,
  },
  {
    name: "suppression-without-reason — a generated file is not authored",
    caught: false,
    file: "apps/web/src/routeTree.gen.ts",
    code: `/* eslint-disable */`,
  },
];

/** @returns {string[]} One message per failed fixture; empty when all pass. */
/**
 * One message per `gate` rule that no must-catch fixture names. A gate is
 * covered only by a fixture with `caught: true` and `rule: <its id>`, and the
 * attribution check in {@link selfTestFailures} then proves that fixture really
 * fires the row. A match that lands on a gate by accident does not count.
 * @returns {string[]}
 */
function gateCoverageFailures() {
  const named = new Set(
    [...CASES, ...LINE_CASES].filter((fixture) => fixture.caught).map((fixture) => fixture.rule),
  );

  return RULES.filter((rule) => rule.severity === "gate" && !named.has(rule.id)).map(
    (rule) =>
      `gate rule ${rule.id} has no must-catch fixture: add one with \`rule: "${rule.id}"\` to ${rule.scope === "chain" ? "CASES" : "LINE_CASES"}`,
  );
}

/** @returns {string[]} One message per failed fixture; empty when all pass. */
export function selfTestFailures() {
  const failures = [...registryUnionFailures(), ...gateCoverageFailures()];

  for (const { name, caught, code, file, rule, lanes } of CASES) {
    const hits = matchChains(code, file ?? FILE, lanes ?? "gate");

    if (caught && rule === undefined) {
      failures.push(`fixture "${name}" must catch but names no \`rule\``);
    } else if (hits.length > 0 !== caught) {
      failures.push(
        caught
          ? `missed a case it must catch: ${name}`
          : `flagged a case it must ignore: ${name} (matched line ${hits[0].line})`,
      );
    } else if (caught && rule !== undefined) {
      const ids = hits.map((h) => h.rule.id);

      if (!ids.includes(rule)) {
        failures.push(
          `fixture "${name}" names ${rule} but matched ${ids.join(", ") || "nothing"} instead`,
        );
      }
    }
  }

  for (const { name, caught, code, file, rule, lanes } of LINE_CASES) {
    const hits = code
      .split("\n")
      .flatMap((line) => matchLine(line, file ?? LINE_FILE, lanes ?? "gate"));

    if (caught && rule === undefined) {
      failures.push(`fixture "${name}" must catch but names no \`rule\``);
    } else if (hits.length > 0 !== caught) {
      failures.push(
        caught
          ? `missed a case it must catch: ${name}`
          : `flagged a case it must ignore: ${name} (${hits[0].id})`,
      );
    } else if (caught && rule !== undefined) {
      const ids = hits.map((h) => h.id);

      if (!ids.includes(rule)) {
        failures.push(
          `fixture "${name}" names ${rule} but matched ${ids.join(", ") || "nothing"} instead`,
        );
      }
    }
  }

  return failures;
}
