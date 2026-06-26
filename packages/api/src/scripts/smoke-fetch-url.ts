/**
 * Live smoke for `system.fetch_url` (#286). Exercises the real network +
 * connect-time SSRF pinning that the unit tests stub out. No DB / server needed.
 *
 *   $ ./node_modules/.bin/tsx packages/api/src/scripts/smoke-fetch-url.ts
 *   (or: pnpm --filter @alfred/api exec tsx src/scripts/smoke-fetch-url.ts)
 *
 * Expectations:
 *   - a real public page reads in as text with a title;
 *   - a compressed text response is transparently decoded before sniffing;
 *   - a name that *resolves to loopback* (127.0.0.1.nip.io) is BLOCKED — proves
 *     the pin validates the resolved IP, not just the hostname string;
 *   - an IPv4-mapped IPv6 literal is BLOCKED;
 *   - a redirect into cloud-metadata space is BLOCKED at the hop.
 */

import { runFetchUrl } from "../modules/tools/fetch-url.js";

interface Case {
  label: string;
  url: string;
  expect: "ok" | "blocked";
  contains?: string;
}

const CASES: Case[] = [
  { label: "public page reads as text", url: "https://www.yashk.xyz", expect: "ok" },
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
    label: "IPv4-mapped IPv6 literal is blocked",
    url: "http://[::ffff:127.0.0.1]/",
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
  let failures = 0;
  for (const c of CASES) {
    const r = await runFetchUrl({ url: c.url });
    const got = r.ok ? "ok" : r.reason === "blocked_host" ? "blocked" : `error:${r.reason}`;
    const pass =
      c.expect === "blocked"
        ? got === "blocked"
        : got === "ok" && (!c.contains || (r.ok && r.text.includes(c.contains)));
    if (!pass) failures++;
    const detail = r.ok
      ? `title=${JSON.stringify(r.title)} chars=${r.chars} ct=${r.contentType}`
      : `reason=${r.reason} msg=${JSON.stringify(r.message)}`;
    console.log(`${pass ? "✓" : "✗"} [${c.label}] expect=${c.expect} got=${got} — ${detail}`);
  }
  console.log(failures === 0 ? "\nall smoke cases passed" : `\n${failures} smoke case(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
