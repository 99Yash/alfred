// Fixtures and assertions for ./schema-catalog.mjs. Exported as a failure
// list so check-schema-catalog can gate the detector the same way
// consolidation-rules.selftest gates its matchers: a clean run over a broken
// detector is indistinguishable from a clean run over a working one.

import { scanFile, findDupes } from "./schema-catalog.mjs";

const FIXTURE_TWO_SCHEMAS = `
export const widgetSchema = z.object({
  id: z.string(),
  count: z.number().optional(),
});

const internalGadget = z.object({
  id: z.string(),
  count: z.number().optional(),
});
`;

const FIXTURE_ANNOTATION_AND_EXPORTS = `
import type { z } from "zod";
export const framedSchema: z.ZodType<Frame> = z.object({
  kind: z.literal("frame"),
});
export let mutableSchema = z.enum(["a", "b"]);
const derived = framedSchema.extend({
  extra: z.boolean(),
});
const unrelatedChain = someBuilder.pick({ x: true });
`;

const FIXTURE_NO_SCHEMAS = `
export function helper(value: unknown) {
  return z.record;
}
const notASchema = builder.where({ id: 1 });
`;

/** One balanced object body, comments included so stripping is exercised. */
const FIXTURE_COMMENT_BODY = `
export const commentedSchema = z.object({
  // id: z.string() as a comment must not become a key
  name: z.string(), /* block, { with brace } */
});
export const plainSchema = z.object({
  name: z.string(),
});
export const differentSchema = z.object({
  label: z.string(),
  flag: z.boolean(),
});
`;

function collectFailures() {
  const failures = [];

  // Direct defs: exported vs local, both counted, names exact.
  const two = scanFile(FIXTURE_TWO_SCHEMAS);
  const twoNames = two.map((def) => def.name).sort();
  if (twoNames.join(",") !== "internalGadget,widgetSchema") {
    failures.push(`FIXTURE_TWO_SCHEMAS names: [${twoNames.join(", ")}]`);
  }
  const exportedStates = Object.fromEntries(two.map((def) => [def.name, def.exported]));
  if (exportedStates.widgetSchema !== true || exportedStates.internalGadget !== false) {
    failures.push(`FIXTURE_TWO_SCHEMAS export flags: ${JSON.stringify(exportedStates)}`);
  }

  // Annotations, let-bindings, and composition off a known base.
  const ann = scanFile(FIXTURE_ANNOTATION_AND_EXPORTS);
  const annNames = ann.map((def) => def.name).sort();
  if (!annNames.includes("framedSchema")) {
    failures.push(`annotation-parsed def missing framedSchema: [${annNames.join(", ")}]`);
  }
  if (!annNames.includes("mutableSchema")) {
    failures.push(`let-binding def missing mutableSchema: [${annNames.join(", ")}]`);
  }
  if (!annNames.includes("derived")) {
    failures.push(`composition def missing derived: [${annNames.join(", ")}]`);
  }
  if (annNames.includes("unrelatedChain")) {
    failures.push("composition matched a non-schema fluent chain (unrelatedChain)");
  }

  // Absence: referencing z or calling other builders is not a definition.
  const none = scanFile(FIXTURE_NO_SCHEMAS);
  if (none.length !== 0) {
    failures.push(`FIXTURE_NO_SCHEMAS expected zero defs, got ${none.length}`);
  }

  // Comment stripping: both bodies normalize to the same signature despite
  // the comment text, and braces inside the block comment stay balanced.
  const commented = scanFile(FIXTURE_COMMENT_BODY);
  const sigs = commented.map((def) => def.signature);
  if (sigs.some((sig) => sig === null || sig === undefined)) {
    failures.push(`FIXTURE_COMMENT_BODY lost a signature: ${JSON.stringify(sigs)}`);
  }
  if (commented[0]?.signature !== commented[1]?.signature) {
    failures.push("commented and plain object bodies should normalize to one signature");
  }
  if (commented[0]?.signature?.includes("as a comment")) {
    failures.push("line-comment text leaked into the normalized signature");
  }

  // Dupe grouping: two distinct names over one shape form exactly one group;
  // the third, genuinely different body stays out of it.
  const dupeScan = [
    {
      pkg: "one",
      file: "packages/one/src/a.ts",
      defs: scanFile(FIXTURE_COMMENT_BODY),
    },
  ];
  const groups = findDupes(dupeScan);
  if (groups.length !== 1 || groups[0][1].length !== 2) {
    failures.push(`expected 1 dupe group of 2 sites, got ${JSON.stringify(groups)}`);
  }
  if (groups[0] && !groups[0][1].every((site) => site.includes("packages/one/src/a.ts"))) {
    failures.push(`dupe group sites carry wrong file labels: ${JSON.stringify(groups[0][1])}`);
  }

  // Two different bodies never group.
  const distinctScan = [
    {
      pkg: "one",
      file: "packages/one/src/b.ts",
      defs: [
        { name: "left", kind: "z.object", exported: true, signature: "{ a: z.string() }" },
        { name: "right", kind: "z.object", exported: true, signature: "{ b: z.number() }" },
      ],
    },
  ];
  if (findDupes(distinctScan).length !== 0) {
    failures.push("distinct bodies grouped as duplicates");
  }

  return failures;
}

export function schemaCatalogSelfTestFailures() {
  try {
    return collectFailures();
  } catch (error) {
    return [`self-test threw: ${error instanceof Error ? error.message : String(error)}`];
  }
}
