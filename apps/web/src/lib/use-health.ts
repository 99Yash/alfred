import { useEffect, useState } from "react";

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

/**
 * Polls the API `/health` endpoint once on mount to drive the landing's
 * server-status pill. Kept deliberately lightweight: it never blocks first
 * paint — the pill starts in a loading state and resolves to online/unreachable
 * once the round-trip completes. A 4s timeout treats a hung server as
 * unreachable rather than spinning forever.
 */
export function useHealth(): { healthOk: boolean; healthLoading: boolean } {
  const [state, setState] = useState<{ healthOk: boolean; healthLoading: boolean }>({
    healthOk: false,
    healthLoading: true,
  });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);

    fetch(`${API_URL}/health`, { signal: controller.signal })
      .then((res) => {
        if (cancelled) return;
        setState({ healthOk: res.ok, healthLoading: false });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ healthOk: false, healthLoading: false });
      })
      .finally(() => clearTimeout(timeout));

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  return state;
}
