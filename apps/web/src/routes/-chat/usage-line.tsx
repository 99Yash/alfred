import type { SyncedChatMessage } from "@alfred/sync";

/** Compact token count: 1234 → "1.2k", 512 → "512". */
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** Trim a model id's dated suffix for the readout ("claude-haiku-4-5-20251001" → "claude-haiku-4-5"). */
function shortModel(id: string): string {
  return id.replace(/-\d{8}$/, "");
}

/**
 * Dev-only per-turn token + cost readout under an assistant reply. Gated by the
 * caller on `import.meta.env.DEV` (stripped from prod bundles) — it exposes the
 * raw economics of the turn (boss run only; sub-agents bill separately) so we
 * can eyeball cost while iterating. Numbers come from the synced `usage` rollup
 * (aggregated server-side from `api_call_log`); absent on older messages.
 *
 * The served model(s) are shown so a silent provider fallback is visible at a
 * glance — a turn you expected on `claude-*` showing `gemini-*` means the
 * Anthropic primary errored (spend cap, 429) and `withFallback` degraded it.
 */
export function UsageLine({ usage }: { usage: NonNullable<SyncedChatMessage["usage"]> }) {
  const cost =
    usage.costUsd >= 0.01 ? `$${usage.costUsd.toFixed(3)}` : `$${usage.costUsd.toFixed(5)}`;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-app-fg-2 tabular-nums">
      <span title="Input tokens">↑ {formatTokens(usage.inputTokens)}</span>
      <span aria-hidden>·</span>
      <span title="Output tokens">↓ {formatTokens(usage.outputTokens)}</span>
      {usage.cachedInputTokens > 0 ? (
        <>
          <span aria-hidden>·</span>
          <span title="Cached input tokens">⚡ {formatTokens(usage.cachedInputTokens)}</span>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <span title="Turn cost (boss run)" className="text-app-fg-3">
        {cost}
      </span>
      <span aria-hidden>·</span>
      <span title="LLM calls this turn">{usage.calls} calls</span>
      {usage.models.map((m) => (
        <span
          key={m.model}
          title="Model served this turn (× call count)"
          className="rounded bg-app-bg-2 px-1 text-app-fg-3"
        >
          {shortModel(m.model)}
          {m.calls > 1 ? ` ×${m.calls}` : ""}
        </span>
      ))}
    </div>
  );
}
