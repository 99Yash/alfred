/**
 * The sources of a script (ADR-0124 amendment 2026-11-18): the web pages of its reads, from the
 * evidence record. A count cap and a byte cap bound them. Each kept URL is whole, and the count of
 * pages left out is returned.
 */

import { SCRIPT_SOURCES_MAX, type ReadEvidenceRef, type ScriptSource } from "@alfred/contracts";
import { SCRIPT_SOURCES_MAX_BYTES } from "./result-budget";

export function scriptSources(refs: readonly Extract<ReadEvidenceRef, { kind: "web" }>[]) {
  const byUrl = new Map<string, ScriptSource>();

  for (const ref of refs) {
    if (!byUrl.has(ref.url))
      byUrl.set(ref.url, ref.title ? { url: ref.url, title: ref.title } : { url: ref.url });
  }

  const sources: ScriptSource[] = [];
  // `[` and `]` of the JSON array.
  let bytes = 2;

  for (const source of byUrl.values()) {
    // The source and its comma.
    const size = Buffer.byteLength(JSON.stringify(source)) + 1;

    if (sources.length >= SCRIPT_SOURCES_MAX || bytes + size > SCRIPT_SOURCES_MAX_BYTES) break;

    sources.push(source);
    bytes += size;
  }

  return { sources, omitted: byUrl.size - sources.length };
}
