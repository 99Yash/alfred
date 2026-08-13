/**
 * Live smoke for `system.fetch_url` (#286). Exercises the real network +
 * connect-time SSRF pinning that the unit tests stub out. No DB / server needed.
 *
 *   $ pnpm --filter @alfred/assistant exec tsx src/scripts/smoke-fetch-url.ts
 *
 * Expectations:
 *   - a real public page reads in as text with a title;
 *   - a compressed text response is transparently decoded before sniffing;
 *   - a name that *resolves to loopback* (127.0.0.1.nip.io) is BLOCKED — proves
 *     the pin validates the resolved IP, not just the hostname string;
 *   - IANA special-use IPv4 literals are BLOCKED before the socket path;
 *   - an IPv4-mapped IPv6 literal is BLOCKED;
 *   - an IPv4-compatible IPv6 literal is BLOCKED;
 *   - a redirect into cloud-metadata space is BLOCKED at the hop;
 *   - a client-rendered SPA (x.com) reads back empty_content, not a silent
 *     ok:chars:0 (#509) — and escalates to the Firecrawl renderer when a key is
 *     set (#510). With no FIRECRAWL_API_KEY the honest empty_content stands.
 */

import { getPath, getStringPath } from "@alfred/contracts";
import { DEFAULT_USER_TIMEZONE } from "@alfred/assistant/time";
import { registerBuiltinTools } from "@alfred/assistant/tool-runtime/builtin-tools";
import { toolExecuteContext } from "@alfred/assistant/tool-runtime/context";

interface Case {
  label: string;
  url: string;
  expect: "ok" | "blocked" | "empty_content";
  contains?: string;
}

const CASES: Case[] = [
  { label: "public page reads as text", url: "https://www.yashk.xyz", expect: "ok" },
  {
    // #509/#510: with no Firecrawl key this is empty_content; with a key it flips
    // to ok (rendered bio). Either is a pass for the honesty contract — a silent
    // ok:chars:0 is the failure this guards against.
    label: "x.com is empty_content (or rendered when FIRECRAWL_API_KEY is set)",
    url: "https://x.com/thdxr",
    expect: process.env.FIRECRAWL_API_KEY ? "ok" : "empty_content",
  },
  {
    label: "gzip response decompresses before text sniffing",
    url: "https://nghttp2.org/httpbin/gzip",
    expect: "ok",
    contains: "gzipped",
  },
  {
    label: "nip.io → loopback is blocked",
    url: "http://127.0.0.1.nip.io/secret",
    expect: "blocked",
  },
  {
    label: "benchmark IPv4 literal is blocked",
    url: "http://198.18.0.1/",
    expect: "blocked",
  },
  {
    label: "IPv4-mapped IPv6 literal is blocked",
    url: "http://[::ffff:127.0.0.1]/",
    expect: "blocked",
  },
  {
    label: "IPv4-compatible IPv6 literal is blocked",
    url: "http://[::7f00:1]/",
    expect: "blocked",
  },
  {
    label: "redirect into metadata is blocked",
    // The redirector 302s to the target; our manual re-validation must refuse the hop.
    url: "https://nghttp2.org/httpbin/redirect-to?url=http://169.254.169.254/latest/meta-data",
    expect: "blocked",
  },
];

async function main(): Promise<void> {
  const registry = registerBuiltinTools();
  const tool = registry.get("system.fetch_url");
  if (!tool) throw new Error("system.fetch_url did not register");
  const context = toolExecuteContext({
    runId: "smoke-run",
    scratchpadRunId: "smoke-run",
    stepId: "smoke-step",
    toolCallId: "smoke-call",
    userId: "smoke-user",
    caller: "boss",
    runContext: { caller: "boss", interaction: "background" },
    timezone: DEFAULT_USER_TIMEZONE,
  });

  let failures = 0;
  for (const c of CASES) {
    const result = await tool.execute({ url: c.url }, context);
    const ok = getPath(result, "ok") === true;
    const reason = getStringPath(result, "reason");
    const text = getStringPath(result, "text");
    const got = ok ? "ok" : reason === "blocked_host" ? "blocked" : `error:${reason}`;
    const pass =
      c.expect === "blocked"
        ? got === "blocked"
        : c.expect === "empty_content"
          ? got === "error:empty_content"
          : got === "ok" && (!c.contains || text?.includes(c.contains) === true);
    if (!pass) failures++;
    const detail = ok
      ? `title=${JSON.stringify(getStringPath(result, "title"))} chars=${String(getPath(result, "chars"))} ct=${getStringPath(result, "contentType")}`
      : `reason=${reason} msg=${JSON.stringify(getStringPath(result, "message"))}`;
    console.log(`${pass ? "✓" : "✗"} [${c.label}] expect=${c.expect} got=${got} — ${detail}`);
  }
  console.log(failures === 0 ? "\nall smoke cases passed" : `\n${failures} smoke case(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
