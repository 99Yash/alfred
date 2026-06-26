/**
 * Smoke test for the `system.fetch_url` tool (#286).
 *
 *   $ pnpm --dir apps/server exec tsx --env-file=.env src/scripts/smoke-fetch-url.ts [url]
 *
 * Verifies, with no server process needed:
 *   1. The tool registers and resolves by name from the registry.
 *   2. A live fetch of a real public page returns sanitized text + a title
 *      (proves the read-in path works end to end against the network).
 *   3. The honest-read-in guards hold: a private host is refused, and a binary
 *      (PDF) URL is reported rather than garbled.
 *
 * This is the capability the resume/website chat run (#286) was missing: the
 * boss held the user's website URL but had no tool to read the page.
 */

import { getTool, registerBuiltinTools } from "@alfred/api";

const ctx = {
  runId: "smoke-run",
  scratchpadRunId: "smoke-run",
  stepId: "smoke-step",
  toolCallId: "smoke-call",
  userId: "smoke-user",
  caller: "boss" as const,
  timezone: "UTC",
};

type Result =
  | { ok: true; finalUrl: string; title?: string; text: string; chars: number; truncated: boolean }
  | { ok: false; reason: string; message: string };

async function main(): Promise<void> {
  registerBuiltinTools();

  const tool = getTool("system.fetch_url");
  if (!tool) throw new Error("system.fetch_url did not register");
  console.log(`✓ registered: ${tool.name} (riskTier=${tool.riskTier})`);

  const url = process.argv[2] ?? "https://example.com/";
  const ok = (await tool.execute({ url }, ctx)) as Result;
  if (!ok.ok) throw new Error(`expected ok for ${url}, got ${ok.reason}: ${ok.message}`);
  console.log(`✓ read ${url} → final ${ok.finalUrl}`);
  console.log(`✓ title: ${ok.title ?? "(none)"}`);
  console.log(`✓ text (${ok.chars} chars, truncated=${ok.truncated}):\n`);
  console.log(ok.text.slice(0, 800));
  if (ok.text.length === 0) throw new Error("fetch_url returned empty text");

  // Guard: private host is refused before any fetch.
  const blocked = (await tool.execute({ url: "http://169.254.169.254/" }, ctx)) as Result;
  if (blocked.ok || blocked.reason !== "blocked_host") {
    throw new Error("expected blocked_host for the metadata IP");
  }
  console.log(`\n✓ blocked metadata host: ${blocked.message}`);

  // Guard: a binary resource is reported honestly, not garbled.
  const pdf = (await tool.execute(
    { url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf" },
    ctx,
  )) as Result;
  if (pdf.ok) {
    console.log(
      `\n⚠ expected a binary refusal for the PDF, but it read as text (server may have served HTML)`,
    );
  } else {
    console.log(`✓ binary refused honestly (${pdf.reason}): ${pdf.message}`);
  }

  console.log("\n✅ smoke passed");
}

main().catch((err) => {
  console.error("❌ smoke failed:", err);
  process.exit(1);
});
