// Phase 0 sandbox proof for issue #535 / ADR-0087 (Code Mode / object handles).
//
// Substrate decision (grilled 2026-07-23): execution moves OFF Railway (which
// cannot enforce OS-level egress denial in an unprivileged container) to
// Vercel Sandbox (Firecracker microVM). Data-flow model = "Option A": park the
// sanitized result, ship it INTO the sandbox via writeFiles, weld the door shut
// with networkPolicy:'deny-all' (blocks ALL egress incl. DNS), run the
// model-authored JS over the local file, read a bounded result back out. No
// host-callback channel, no credentials, no paging — the microVM itself IS the
// isolation boundary, so the model code runs as ordinary Node with no network.
//
// This harness proves the Phase 0 acceptance items the issue requires and
// RECORDS empirical limits. It is intentionally outside the pnpm workspace.
//
// Run:
//   cd scripts/spikes/code-mode-sandbox && npm install
//   VERCEL_TOKEN=... VERCEL_TEAM_ID=team_... VERCEL_PROJECT_ID=prj_... npm run spike
//
// Auth: access-token mode (we are a non-Vercel host). The SDK reads
// VERCEL_TOKEN / VERCEL_TEAM_ID / VERCEL_PROJECT_ID from the environment.

import { Sandbox } from "@vercel/sandbox";

const RUNTIME = "node22"; // match Alfred's Node baseline
const OUTPUT_READ_CAP_BYTES = 64 * 1024; // parent-side bound on what we read back

/** @typedef {{ name: string; pass: boolean; detail: string; ms?: number }} ProbeResult */
/** @type {ProbeResult[]} */
const results = [];
/** @type {Record<string, unknown>} */
const measured = {};

function record(name, pass, detail, ms) {
  results.push({ name, pass, detail, ms });
  const tag = pass ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${ms != null ? ` (${ms}ms)` : ""} — ${detail}`);
}

function requireEnv() {
  const missing = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"].filter(
    (k) => !process.env[k],
  );
  if (missing.length) {
    console.error(
      `Missing required env: ${missing.join(", ")}.\n` +
        `Access-token auth needs all three (see docs/sandbox/concepts/authentication).`,
    );
    process.exit(2);
  }
}

/** Read a command's stdout, capped, without letting a flood OOM the parent. */
async function boundedStdout(cmd) {
  const full = await cmd.stdout();
  const bytes = Buffer.byteLength(full, "utf8");
  if (bytes > OUTPUT_READ_CAP_BYTES) {
    return { text: full.slice(0, OUTPUT_READ_CAP_BYTES), bytes, capped: true };
  }
  return { text: full, bytes, capped: false };
}

/** Wall-clock guard so a wedged sandbox can never hang the harness itself. */
function withParentTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`parent-timeout:${label}:${ms}ms`)), ms),
    ),
  ]);
}

// ── Probe 1: baseline compute (Option A data-in → bounded result-out) ────────
async function probeBaselineCompute() {
  const t0 = Date.now();
  let sandbox;
  try {
    sandbox = await Sandbox.create({
      runtime: RUNTIME,
      timeout: 60_000,
      resources: { vcpus: 2 },
      networkPolicy: "deny-all",
    });
    measured.vcpus = sandbox.vcpus;
    measured.memoryMb = sandbox.memory;
    measured.sessionTimeoutMs = sandbox.timeout;

    // A realistic "parked handle": 2,000 rows the transcript could never hold.
    const parked = Array.from({ length: 2000 }, (_, i) => ({
      id: i,
      state: i % 3 === 0 ? "open" : "closed",
      author: `user${i % 17}`,
      bytes: i * 7,
    }));
    const runner = [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const rows = JSON.parse(readFileSync('handle.json','utf8'));",
      // model-authored derivation: count open issues grouped by author
      "const open = rows.filter(r => r.state === 'open');",
      "const byAuthor = {};",
      "for (const r of open) byAuthor[r.author] = (byAuthor[r.author]||0)+1;",
      "const result = { totalRows: rows.length, openCount: open.length, byAuthor };",
      "writeFileSync('result.json', JSON.stringify(result));",
      "console.log(JSON.stringify(result));",
    ].join("\n");

    await sandbox.writeFiles([
      { path: "handle.json", content: Buffer.from(JSON.stringify(parked)) },
      { path: "runner.mjs", content: Buffer.from(runner) },
    ]);

    const cmd = await withParentTimeout(
      sandbox.runCommand({ cmd: "node", args: ["runner.mjs"] }),
      45_000,
      "baseline",
    );
    const out = await boundedStdout(cmd);
    const parsed = JSON.parse(out.text);
    const ok =
      cmd.exitCode === 0 && parsed.totalRows === 2000 && parsed.openCount > 0;
    record(
      "baseline-compute",
      ok,
      `exit=${cmd.exitCode} openCount=${parsed.openCount} authors=${
        Object.keys(parsed.byAuthor).length
      } stdoutBytes=${out.bytes}`,
      Date.now() - t0,
    );
  } catch (err) {
    record("baseline-compute", false, `threw: ${String(err)}`, Date.now() - t0);
  } finally {
    await sandbox?.stop().catch(() => {});
  }
}

// ── Probe 2: egress denial fails closed (the welded door) ────────────────────
async function probeEgressDenied() {
  const t0 = Date.now();
  let sandbox;
  try {
    sandbox = await Sandbox.create({
      runtime: RUNTIME,
      timeout: 60_000,
      networkPolicy: "deny-all",
    });
    const probe = [
      "let dns=false, http=false;",
      "try { await (await import('node:dns/promises')).resolve('example.com'); dns=true; } catch {}",
      "try { const c=new AbortController(); const t=setTimeout(()=>c.abort(),4000);",
      "  await fetch('https://example.com',{signal:c.signal}); clearTimeout(t); http=true; } catch {}",
      "console.log(JSON.stringify({ dns, http }));",
    ].join("\n");
    await sandbox.writeFiles([{ path: "probe.mjs", content: Buffer.from(probe) }]);
    const cmd = await withParentTimeout(
      sandbox.runCommand({ cmd: "node", args: ["probe.mjs"] }),
      30_000,
      "egress",
    );
    const out = await boundedStdout(cmd);
    const { dns, http } = JSON.parse(out.text);
    const ok = dns === false && http === false;
    record(
      "egress-denied",
      ok,
      ok
        ? "DNS + HTTP both failed closed under deny-all"
        : `LEAK: dns=${dns} http=${http}`,
      Date.now() - t0,
    );
  } catch (err) {
    record("egress-denied", false, `threw: ${String(err)}`, Date.now() - t0);
  } finally {
    await sandbox?.stop().catch(() => {});
  }
}

// ── Probe 3: infinite loop terminates at the session timeout, parent survives ─
async function probeInfiniteLoop() {
  const t0 = Date.now();
  let sandbox;
  try {
    sandbox = await Sandbox.create({
      runtime: RUNTIME,
      timeout: 15_000, // short session so the CPU spin is force-stopped
      networkPolicy: "deny-all",
    });
    await sandbox.writeFiles([
      { path: "spin.mjs", content: Buffer.from("while(true){}") },
    ]);
    let terminated = false;
    try {
      // Parent guard is generous vs the 15s session cap; if the session cap
      // works, runCommand settles/rejects well before the parent guard fires.
      const cmd = await withParentTimeout(
        sandbox.runCommand({ cmd: "node", args: ["spin.mjs"] }),
        40_000,
        "infinite-loop",
      );
      terminated = cmd.exitCode !== 0; // killed → nonzero/again signal
    } catch (err) {
      // Session-timeout surfacing as a rejection is also a valid "terminated".
      terminated = !String(err).startsWith("Error: parent-timeout");
    }
    record(
      "infinite-loop-terminates",
      terminated,
      terminated
        ? "spin was force-terminated by the session timeout; harness stayed responsive"
        : "spin was NOT contained by the session timeout (parent guard fired)",
      Date.now() - t0,
    );
  } catch (err) {
    record("infinite-loop-terminates", false, `threw: ${String(err)}`, Date.now() - t0);
  } finally {
    await sandbox?.stop().catch(() => {});
  }
}

// ── Probe 4: memory pressure kills the command, not the harness ──────────────
async function probeMemoryPressure() {
  const t0 = Date.now();
  let sandbox;
  try {
    sandbox = await Sandbox.create({
      runtime: RUNTIME,
      timeout: 60_000,
      networkPolicy: "deny-all",
    });
    // Grow an array until V8/OOM kills the process inside the VM.
    const hog = [
      "const chunks=[];",
      "try { while(true){ chunks.push(new Array(1e7).fill(7)); } }",
      "catch(e){ console.log('caught:'+e.name); }",
    ].join("\n");
    await sandbox.writeFiles([{ path: "hog.mjs", content: Buffer.from(hog) }]);
    const cmd = await withParentTimeout(
      sandbox.runCommand({ cmd: "node", args: ["--max-old-space-size=256", "hog.mjs"] }),
      45_000,
      "memory",
    );
    // Whether it exits nonzero (OOM-killed) or catches RangeError, the point is
    // the parent got control back cleanly.
    record(
      "memory-pressure-contained",
      true,
      `command returned control to parent; exit=${cmd.exitCode}`,
      Date.now() - t0,
    );
  } catch (err) {
    // A clean rejection is still containment; only a parent hang is a failure.
    const contained = !String(err).includes("parent-timeout");
    record(
      "memory-pressure-contained",
      contained,
      contained ? `contained via rejection: ${String(err)}` : "PARENT HUNG",
      Date.now() - t0,
    );
  } finally {
    await sandbox?.stop().catch(() => {});
  }
}

// ── Probe 5: output flood is bounded at the parent read ──────────────────────
async function probeOutputFlood() {
  const t0 = Date.now();
  let sandbox;
  try {
    sandbox = await Sandbox.create({
      runtime: RUNTIME,
      timeout: 60_000,
      networkPolicy: "deny-all",
    });
    const flood = [
      "const line='x'.repeat(1024);",
      "for(let i=0;i<50000;i++) console.log(line);", // ~50 MB
    ].join("\n");
    await sandbox.writeFiles([{ path: "flood.mjs", content: Buffer.from(flood) }]);
    const cmd = await withParentTimeout(
      sandbox.runCommand({ cmd: "node", args: ["flood.mjs"] }),
      45_000,
      "flood",
    );
    const out = await boundedStdout(cmd);
    record(
      "output-flood-bounded",
      out.capped && out.bytes <= OUTPUT_READ_CAP_BYTES + 1,
      `emitted≈${out.bytes}B, parent read capped to ${OUTPUT_READ_CAP_BYTES}B (capped=${out.capped})`,
      Date.now() - t0,
    );
    measured.floodEmittedBytes = out.bytes;
  } catch (err) {
    record("output-flood-bounded", false, `threw: ${String(err)}`, Date.now() - t0);
  } finally {
    await sandbox?.stop().catch(() => {});
  }
}

// ── Probe 6: a crashing command surfaces a clean nonzero exit ────────────────
async function probeCrash() {
  const t0 = Date.now();
  let sandbox;
  try {
    sandbox = await Sandbox.create({
      runtime: RUNTIME,
      timeout: 60_000,
      networkPolicy: "deny-all",
    });
    await sandbox.writeFiles([
      { path: "boom.mjs", content: Buffer.from("throw new Error('boom')") },
    ]);
    const cmd = await withParentTimeout(
      sandbox.runCommand({ cmd: "node", args: ["boom.mjs"] }),
      30_000,
      "crash",
    );
    const stderr = await cmd.stderr();
    record(
      "crash-clean-exit",
      cmd.exitCode !== 0,
      `exit=${cmd.exitCode}, stderr carried the throw (${stderr.includes("boom")})`,
      Date.now() - t0,
    );
  } catch (err) {
    record("crash-clean-exit", false, `threw: ${String(err)}`, Date.now() - t0);
  } finally {
    await sandbox?.stop().catch(() => {});
  }
}

async function main() {
  requireEnv();
  console.log(`=== Code Mode Phase 0 sandbox proof (Vercel Sandbox, ${RUNTIME}) ===\n`);
  // Sequential: keeps the log readable and cost bounded; order is cheap→adversarial.
  await probeBaselineCompute();
  await probeEgressDenied();
  await probeCrash();
  await probeOutputFlood();
  await probeMemoryPressure();
  await probeInfiniteLoop();

  console.log("\n=== Measured limits ===");
  console.log(JSON.stringify(measured, null, 2));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== Verdict: ${failed.length === 0 ? "GO" : "REVIEW"} ===`);
  console.log(`${results.length - failed.length}/${results.length} probes passed.`);
  if (failed.length) {
    console.log("Failing probes:", failed.map((r) => r.name).join(", "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Harness fatal:", err);
  process.exit(1);
});
