/**
 * The host-call ledger of one `system.code_run` call (ADR-0124 amendment 2026-11-18). Dispatch
 * owns it: the sandbox host writes the entries, and the staged commit saves them with the parent
 * result. An entry exists from the request, so a read in flight when the script ends stays
 * `unfinished` in the record.
 */

import type { HostCallEntry, HostCallLedger } from "../registry";

export function newHostCallLedger(): HostCallLedger {
  const entries = new Map<number, HostCallEntry & { started: number }>();
  let frozen: readonly HostCallEntry[] | undefined;

  return {
    begin(index, path) {
      const started = performance.now();

      if (frozen === undefined) {
        entries.set(index, {
          index,
          path,
          kind: "unfinished",
          ms: 0,
          call: undefined,
          message: undefined,
          evidence: undefined,
          contentHash: null,
          started,
        });
      }

      let settled = false;

      return (settlement) => {
        if (settled || frozen !== undefined) return;
        settled = true;
        entries.set(index, {
          ...settlement,
          index,
          path,
          ms: Math.round(performance.now() - started),
          started,
        });
      };
    },
    freeze() {
      if (frozen !== undefined) return frozen;

      const now = performance.now();

      frozen = [...entries.values()]
        .toSorted((a, b) => a.index - b.index)
        .map(({ started, ...entry }) =>
          entry.kind === "unfinished" ? { ...entry, ms: Math.round(now - started) } : entry,
        );

      return frozen;
    },
  };
}
