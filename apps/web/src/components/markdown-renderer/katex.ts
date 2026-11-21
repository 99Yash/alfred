/**
 * Lazy katex. The runtime plus its stylesheet sat on the chat critical path
 * while math is rare in a chat app, so the plugin and CSS load the first time
 * a rendered text actually contains math. The promise is shared module-wide,
 * so every math surface awaits the same single load and later renders resolve
 * from the module registry without a round trip.
 */

import type RehypeKatex from "rehype-katex";

export interface KatexModule {
  rehypeKatex: typeof RehypeKatex;
}

let loadPromise: Promise<KatexModule | undefined> | undefined;

export function loadKatex(): Promise<KatexModule | undefined> {
  loadPromise ??= Promise.all([import("rehype-katex"), import("katex/dist/katex.min.css")])
    .then(([plugin]) => ({ rehypeKatex: plugin.default }))
    .catch(() => undefined); // oxlint-disable-line alfred/no-swallowed-catch -- offline: render the raw delimiters rather than crash the message

  return loadPromise;
}
