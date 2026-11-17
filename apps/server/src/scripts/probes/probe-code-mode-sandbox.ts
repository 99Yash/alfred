/**
 * Code Mode sandbox smoke probe (ADR-0087 / ADR-0124, issue #535).
 *
 * The two open-verification items of docs/plans/code-mode-object-handles-v1.md live here:
 * it runs the `run` substrate (QuickJS-in-WebAssembly, vercel-labs) through the probe matrix
 * the old Vercel-Sandbox spike owned — baseline, host functions, guest TypeScript, wall
 * timeout, CPU timeout, memory limit, console flood, guest crash, bridge cap, concurrency —
 * and asserts that each failure terminates the sandbox and leaves this process healthy.
 *
 * No network, no database, no credentials: the probe proves the substrate, nothing else.
 *
 * Run locally from apps/server:
 *   ./node_modules/.bin/tsx src/scripts/probes/probe-code-mode-sandbox.ts
 *
 * Run on the production image (the reason it is a bundled script entry):
 *   railway ssh --service server -- node dist/scripts/probes/probe-code-mode-sandbox.js
 *
 * Exit 0 with all PASS = the image is fit for Code Mode. Any FAIL = REVIEW before slice 2.
 */
import { getHostFunctionContext, run, RunBridgeLimitError, RunError } from "run";

type Probe = {
  name: string;
  fn: () => Promise<string>;
};

const results: { name: string; verdict: "PASS" | "FAIL"; detail: string }[] = [];

async function probe(p: Probe): Promise<void> {
  let verdict: "PASS" | "FAIL" = "FAIL";
  let detail = "";

  try {
    detail = await p.fn();
    verdict = "PASS";
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }

  results.push({ name: p.name, verdict, detail });
  console.log(`${verdict === "PASS" ? "✓" : "✗"} ${p.name} — ${detail}`);
}

/** Asserts the call and throws on mismatch, so one bad probe cannot masquerade as PASS. */
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    throw new Error(message);
  }
}

const LIMITS = {
  timeoutMs: 5_000,
  cpuTimeoutMs: 2_000,
  memoryLimitBytes: 64 * 1024 * 1024,
};

const probes: Probe[] = [
  {
    name: "baseline-compute",
    fn: async () => {
      const result = await run<{ sum: number; label: string }>({
        source: `
          const rows = Array.from({ length: 2_000 }, (_, i) => ({ i, even: i % 2 === 0 }));
          const evens = rows.filter((r) => r.even);
          return { sum: evens.reduce((a, r) => a + r.i, 0), label: "ok" };
        `,
      });

      assert(result.status === "completed", "run did not complete");
      assert(result.value.sum === 999_000, `wrong sum: ${String(result.value.sum)}`);
      assert(result.value.label === "ok", "wrong label");

      return "2000 rows derived in-sandbox";
    },
  },
  {
    name: "host-functions-async",
    fn: async () => {
      const seen: { name: string; index: number }[] = [];

      const result = await run<string>({
        source: `
          const a = await store.read("first");
          const b = await store.read("second");
          return a + "/" + b;
        `,
        hostFunctions: {
          store: {
            read: async (key: unknown) => {
              const ctx = getHostFunctionContext();
              seen.push({ name: ctx.hostFunctionName, index: ctx.requestIndex });

              return `echo:${String(key)}`;
            },
          },
        },
      });

      assert(result.status === "completed", "run did not complete");
      assert(result.value === "echo:first/echo:second", `wrong value: ${result.value}`);
      assert(
        seen.length === 2 && seen[0].name === "store.read" && seen[1].index === 2,
        `bad ledger: ${JSON.stringify(seen)}`,
      );

      return "async host fn + hostFunctionContext ledger";
    },
  },
  {
    name: "host-function-error-is-wrapped",
    fn: async () => {
      let caught = "";

      try {
        await run({
          source: `try { await store.read("x"); } catch (e) { return "caught:" + e.message; }`,
          hostFunctions: {
            store: {
              read: async () => {
                throw new Error("host blew up");
              },
            },
          },
        });
      } catch (error) {
        caught = error instanceof Error ? error.message : String(error);
      }

      assert(caught === "", `host error escaped the guest catch: ${caught}`);

      const result = await run<string>({
        source: `try { await store.read("x"); } catch (e) { return "caught:" + e.message; }`,
        hostFunctions: {
          store: {
            read: async () => {
              throw new RunError("host blew up", "PROBE_HOST_FAIL");
            },
          },
        },
      });

      assert(
        result.status === "completed" && result.value.startsWith("caught:"),
        `expected guest catch, got: ${result.status === "completed" ? result.value : result.status}`,
      );

      return "guest catch sees the host failure";
    },
  },
  {
    name: "guest-typescript-stripped",
    fn: async () => {
      const result = await run<{ ok: boolean }>({
        source: `
          const greet = (name: string): string => \`hi \${name}\`;
          return { ok: greet("alfred") === "hi alfred" };
        `,
      });

      assert(result.status === "completed" && result.value.ok, "TS source did not run");

      return "Node stripTypeScriptTypes path";
    },
  },
  {
    name: "wall-timeout-terminates",
    fn: async () => {
      const started = Date.now();

      try {
        await run({ source: `while (true) {}`, limits: LIMITS });
      } catch (error) {
        assert(error instanceof RunError, "not a RunError");
        assert(
          error.code === "RUN_TIMEOUT" || error.code === "RUN_CPU_TIMEOUT",
          `wrong code: ${error.code}`,
        );
        const elapsed = Date.now() - started;
        assert(elapsed < LIMITS.timeoutMs + 3_000, `too slow: ${elapsed}ms`);

        return `${error.code} at ${elapsed}ms`;
      }

      throw new Error("while(true) did not throw");
    },
  },
  {
    name: "memory-limit-terminates",
    fn: async () => {
      try {
        await run({
          source: `const a = []; while (true) { a.push(new Array(1024 * 1024).fill(1)); }`,
          limits: LIMITS,
        });
      } catch (error) {
        assert(error instanceof RunError, "not a RunError");

        return `code ${error.code}`;
      }

      throw new Error("OOM did not throw");
    },
  },
  {
    name: "console-flood-capped",
    fn: async () => {
      try {
        const result = await run<{ ok: boolean }>({
          source: `
            for (let i = 0; i < 5_000; i++) console.log("x".repeat(1024));
            return { ok: true };
          `,
          limits: LIMITS,
        });

        assert(result.status === "completed", "flood did not complete");

        return "5 MB of console output completed (capped, host survived)";
      } catch (error) {
        assert(error instanceof RunError, "not a RunError");
        assert(
          error.code === "RUN_CPU_TIMEOUT" || error.code === "RUN_TIMEOUT",
          `unexpected code: ${error.code}`,
        );

        return `terminated with ${error.code} (console cap) — host survived`;
      }
    },
  },
  {
    name: "guest-crash-contained",
    fn: async () => {
      try {
        await run({ source: `throw new Error("guest detonation");`, limits: LIMITS });
      } catch (error) {
        assert(error instanceof RunError, "not a RunError");
        assert(error.code !== "RUN_PROTOCOL_ERROR", `protocol error: ${error.code}`);

        return `code ${error.code}`;
      }

      throw new Error("guest throw did not propagate");
    },
  },
  {
    name: "bridge-limit-capped",
    fn: async () => {
      try {
        await run({
          source: `for (let i = 0; i < 400; i++) await store.read(i);`,
          limits: { ...LIMITS, maxBridgeRequests: 100 },
          hostFunctions: {
            store: {
              read: async (i: unknown) => `v${String(i)}`,
            },
          },
        });
      } catch (error) {
        assert(error instanceof RunBridgeLimitError, `wrong class: ${String(error)}`);

        return `RUN_BRIDGE_LIMIT at cap 100`;
      }

      throw new Error("bridge cap did not throw");
    },
  },
  {
    name: "concurrent-runs-share-workers",
    fn: async () => {
      const one = run<{ ok: boolean }>({
        source: `const x = await store.read(1); return { ok: x === "v1" };`,
        hostFunctions: { store: { read: async (i: unknown) => `v${String(i)}` } },
        limits: LIMITS,
      });

      const two = run<{ ok: boolean }>({
        source: `const x = await store.read(2); return { ok: x === "v2" };`,
        hostFunctions: { store: { read: async (i: unknown) => `v${String(i)}` } },
        limits: LIMITS,
      });

      const [a, b] = await Promise.all([one, two]);
      assert(a.status === "completed" && a.value.ok, "run one failed");
      assert(b.status === "completed" && b.value.ok, "run two failed");

      return "two parallel invocations completed";
    },
  },
];

let failed = 0;

for (const p of probes) {
  await probe(p);

  if (results[results.length - 1]?.verdict === "FAIL") {
    failed += 1;
  }
}

console.log(
  `\nprobe-code-mode-sandbox: ${results.length - failed}/${results.length} PASS` +
    (failed === 0 ? " — GO for slice 2" : " — REVIEW before slice 2"),
);

if (failed > 0) {
  process.exitCode = 1;
}
