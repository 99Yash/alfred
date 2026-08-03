/**
 * One-off measurement: how much do the `system.*` tool schemas cost, in tokens,
 * when sent to the model each turn?
 *
 * Uses the repo's OWN production accounting — `capabilitySchemaSize` from the
 * capability schema budget — the same serialization
 * ({ name, description, inputSchema }) and CHARS_PER_TOKEN estimate that feeds
 * the `runtime.tool_surface` Langfuse span. Bytes are exact; the token column is
 * the chars/4 heuristic the system budgets with.
 *
 * If a *valid* ANTHROPIC_API_KEY is available (env or apps/server/.env), it also
 * prints the real Anthropic `count_tokens` total for the full catalog and kernel.
 *
 * Run: tsx src/scripts/count-system-tool-tokens.ts   (read-only)
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { asSchema } from "ai";
import { getTool, listRegisteredTools } from "../modules/tools";
import { registerBuiltinTools } from "../modules/tools/runtime";
import { systemToolKernel } from "../modules/agent/tool-surface";
import { capabilitySchemaSize } from "../modules/tools/schema-budget";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL = "claude-opus-4-8";

function loadApiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const text = readFileSync(resolve(__dirname, "../../../../apps/server/.env"), "utf8");
    for (const line of text.split("\n")) {
      const m = /^\s*ANTHROPIC_API_KEY=(.+)$/.exec(line);
      if (m?.[1]) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

async function realCount(apiKey: string, names: string[]): Promise<number | null> {
  const tools = await Promise.all(
    names.map(async (name) => {
      const t = getTool(name as never)!;
      return {
        name: name.replace(/\./g, "__"),
        description: t.description,
        input_schema: await asSchema(t.inputSchema).jsonSchema,
      };
    }),
  );
  const body = (t: unknown[]) =>
    JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      ...(t.length ? { tools: t } : {}),
    });
  const call = async (t: unknown[]) => {
    const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: body(t),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { input_tokens: number }).input_tokens;
  };
  const base = await call([]);
  const full = await call(tools);
  if (base == null || full == null) return null;
  return full - base;
}

async function main() {
  registerBuiltinTools();

  const systemTools = listRegisteredTools().filter((t) => t.integration === "system");
  const kernelNames = new Set(systemToolKernel().map(String));

  const rows = systemTools
    .map((t) => {
      const { bytes, tokens } = capabilitySchemaSize(t);
      return { name: t.name, kernel: kernelNames.has(t.name), bytes, tokens };
    })
    .sort((a, b) => b.tokens - a.tokens);

  console.log("per-tool schema size (bytes exact; tokens = repo chars/4 heuristic), desc:\n");
  console.log("  tok   bytes  K  tool");
  for (const r of rows) {
    console.log(
      `  ${String(r.tokens).padStart(4)}  ${String(r.bytes).padStart(5)}  ${r.kernel ? "K" : " "}  ${r.name}`,
    );
  }

  const allBytes = rows.reduce((s, r) => s + r.bytes, 0);
  const allTok = rows.reduce((s, r) => s + r.tokens, 0);
  const kRows = rows.filter((r) => r.kernel);
  const kBytes = kRows.reduce((s, r) => s + r.bytes, 0);
  const kTok = kRows.reduce((s, r) => s + r.tokens, 0);

  console.log("\n--- totals (heuristic) ---");
  console.log(`ALL ${rows.length} system tools (pre-#405 eager)  : ${allTok} tok  (${allBytes} B)`);
  console.log(`kernel ${kRows.length} tools (current eager)        : ${kTok} tok  (${kBytes} B)`);

  const key = loadApiKey();
  if (key) {
    const realAll = await realCount(
      key,
      rows.map((r) => r.name),
    );
    const realKernel = await realCount(
      key,
      kRows.map((r) => r.name),
    );
    if (realAll != null) {
      console.log("\n--- totals (REAL Anthropic count_tokens) ---");
      console.log(`ALL ${rows.length} system tools : ${realAll} tok`);
      console.log(`kernel ${kRows.length} tools     : ${realKernel} tok`);
    } else {
      console.log("\n(real count_tokens skipped — ANTHROPIC_API_KEY invalid/expired)");
    }
  } else {
    console.log("\n(real count_tokens skipped — no ANTHROPIC_API_KEY)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
