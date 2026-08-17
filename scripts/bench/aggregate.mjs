#!/usr/bin/env node
// Aggregate benchmark results. Reads all report.json files under
// references/bench/<taskId>/grade-*/ and prints per-task and per-model
// summaries.
//
// Usage:
//   node scripts/bench/aggregate.mjs [--model <model>]

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
/** @type {string | null} */
let filterModel = null;
for (let i = 2; i < args.length; i += 1) {
  if (args[i] === "--model" && args[i + 1]) filterModel = args[i + 1];
}

const ROOT = "references/bench";

function findReports() {
  const reports = [];
  const taskDirs = readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const taskId of taskDirs) {
    const taskPath = join(ROOT, taskId);
    const entries = readdirSync(taskPath, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("grade-run-"))
      .map((d) => d.name);

    for (const entry of entries) {
      const reportPath = join(taskPath, entry, "report.json");
      try {
        const report = JSON.parse(readFileSync(reportPath, "utf8"));
        reports.push({ taskId, entry, ...report });
      } catch {
        // No report or malformed.
      }
    }
  }
  return reports;
}

function findMeta() {
  const metas = [];
  const taskDirs = readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const taskId of taskDirs) {
    const taskPath = join(ROOT, taskId);
    const entries = readdirSync(taskPath, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("grade-"))
      .map((d) => d.name);

    for (const entry of entries) {
      const metaPath = join(taskPath, entry, "meta.json");
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        metas.push({ taskId, entry, ...meta });
      } catch {
        // No meta or malformed.
      }
    }
  }
  return metas;
}

const reports = findReports();
const metas = findMeta();

// Merge reports with metadata.
const runs = reports.map((r) => {
  const runMeta = metas.find((m) => m.taskId === r.taskId);
  return {
    taskId: r.taskId,
    entry: r.entry,
    model: runMeta?.model ?? "unknown",
    verdict: r.verdict,
    duration: runMeta
      ? (new Date(runMeta.finishedAt).getTime() - new Date(runMeta.startedAt).getTime()) / 1000
      : null,
    install: runMeta?.install ?? false,
    verify: r.verify,
    conduct: r.conduct,
    processLane: r.processLane ?? null,
  };
});

// Keep only the latest grade-run per task.
const latestByTask = new Map();
for (const run of runs) {
  if (!run.entry.startsWith("grade-run-")) continue;
  const existing = latestByTask.get(run.taskId);
  if (!existing || run.entry > existing.entry) latestByTask.set(run.taskId, run);
}
const filtered = filterModel
  ? [...latestByTask.values()].filter((r) => r.model === filterModel)
  : [...latestByTask.values()];

// Per-task summary.
console.log("=== Per-task results ===");
for (const run of filtered) {
  const verifyPass = run.verify.every((v) => v.ok);
  const conductPass = run.conduct.every((c) => c.ok);
  const processPass = run.processLane === null || run.processLane.every((p) => p.ok);
  const duration = run.duration !== null ? `${Math.round(run.duration)}s` : "?";
  console.log(
    `  ${run.taskId}: ${run.verdict} (${run.model}, ${duration}, verify=${verifyPass}, conduct=${conductPass}, process=${processPass})`,
  );
}

// Per-model summary.
const byModel = new Map();
for (const run of filtered) {
  if (!byModel.has(run.model)) byModel.set(run.model, []);
  byModel.get(run.model).push(run);
}

console.log("\n=== Per-model summary ===");
for (const [model, modelRuns] of byModel) {
  const total = modelRuns.length;
  const passed = modelRuns.filter((r) => r.verdict === "pass").length;
  const rate = total > 0 ? ((passed / total) * 100).toFixed(0) : "n/a";
  console.log(`  ${model}: ${passed}/${total} pass (${rate}%)`);
}

// Conduct violations.
const conductFails = filtered.filter((r) => r.conduct.some((c) => !c.ok));
if (conductFails.length > 0) {
  console.log("\n=== Conduct violations ===");
  for (const run of conductFails) {
    for (const c of run.conduct.filter((c) => !c.ok)) {
      console.log(`  ${run.taskId}: ${c.detail} (${c.file})`);
    }
  }
}

// Process lane violations.
const processFails = filtered.filter(
  (r) => r.processLane !== null && r.processLane.some((p) => !p.ok),
);
if (processFails.length > 0) {
  console.log("\n=== Process lane violations ===");
  for (const run of processFails) {
    for (const p of run.processLane.filter((p) => !p.ok)) {
      console.log(`  ${run.taskId}: ${p.rule} — ${p.detail}`);
    }
  }
}
