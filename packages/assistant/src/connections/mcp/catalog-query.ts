/** The word rules that `mcp.list_tools` and `system.search_tools` share for MCP catalogs. */

import { singularizeWord } from "@alfred/contracts";

const STOP_WORDS = new Set(["a", "an", "and", "for", "in", "my", "of", "on", "the", "to", "with"]);

/** Every connection label can carry these words, so they name no connection. */
const GENERIC_CONNECTION_WORDS = new Set(["mcp", "server", "connection"]);

/** Lowercase singular words. `list-projects` and "List projects" give the same set. */
export function catalogWords(text: string): Set<string> {
  const words = new Set<string>();

  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length > 1 && !STOP_WORDS.has(word)) words.add(singularizeWord(word));
  }

  return words;
}

/** The words of a connection label that name it: "Railway MCP" gives `railway`. */
export function connectionNameWords(label: string): Set<string> {
  const words = catalogWords(label);

  for (const word of GENERIC_CONNECTION_WORDS) words.delete(word);

  return words;
}
