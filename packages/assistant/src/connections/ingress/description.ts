import { flattenJson, type InboundEventSource, INTEGRATION_DISPLAY_NAMES } from "@alfred/contracts";
import type { InboundDescription } from "./descriptor";

/** Fallback for every provider kind without a named describer. */
export function describeInboundJson(
  source: InboundEventSource,
  kind: string,
  payload: unknown,
): InboundDescription {
  // A shortened URL can name a different resource. Omit it from text and citations.
  const leaves = flattenJson(payload).filter(
    (leaf) => !leaf.truncated || !/^https?:\/\//i.test(leaf.value),
  );
  const title = `${INTEGRATION_DISPLAY_NAMES[source]}: ${kind}`;
  const text = leaves.map((leaf) => `${leaf.path.join(".")}: ${leaf.value}`).join("\n");
  // Prefer browser links over API URLs; ignore avatar and other asset fields.
  const links = leaves.filter((leaf) => /^https?:\/\//i.test(leaf.value));
  const url = ["html_url", "permalink", "web_url", "url"].flatMap((key) =>
    links.filter((leaf) => leaf.path.at(-1) === key),
  )[0]?.value;
  return {
    title,
    summary: `${title}${text ? `: ${text}` : ""}`.replace(/\s+/g, " ").slice(0, 400),
    body: `${title}\n${text}`,
    url,
  };
}
