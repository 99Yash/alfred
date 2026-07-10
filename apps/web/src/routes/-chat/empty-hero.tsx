import { authClient } from "~/lib/auth/auth-client";
import { firstName, greeting } from "~/lib/user-display";
import { Composer } from "./composer/composer";
import type { ChatTier } from "./model-tier-picker";
import { ConnectToolsBar } from "./connect-tools-bar";

export function EmptyHero({
  threadId,
  isStreaming,
  onSend,
  autoApprove,
  autoApprovePending,
  onToggleAutoApprove,
  tier,
  onTierChange,
}: {
  threadId: string | undefined;
  isStreaming: boolean;
  onSend?: (text: string, files?: File[], artifactTargetId?: string) => Promise<boolean>;
  autoApprove?: boolean;
  autoApprovePending?: boolean;
  onToggleAutoApprove?: () => void;
  tier: ChatTier;
  onTierChange: (tier: ChatTier) => void;
}) {
  const { data: session } = authClient.useSession();
  const name = firstName(session?.user);
  const now = new Date();

  // Cluster greeting + composer + connect-tools as a single block centered
  // in the remaining viewport. flex-col + justify-center keeps the group
  // tight whether the column is 600px or 1000px tall.
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6">
      <div className="flex flex-col items-center">
        <p className="text-[11px] font-medium tracking-tight text-app-fg-2 uppercase">
          {formatDate(now)}
        </p>
        <h2 className="mt-3 text-center text-3xl font-medium tracking-[-0.04em] text-app-fg-4 md:text-4xl">
          {greeting(now)}
          {name ? <span className="text-app-fg-3">, {name}</span> : null}
        </h2>
      </div>

      {/* Composer + connect-tools shelf share a column so the shelf reads
       * as part of the same affordance — the composer flattens its bottom
       * edge and the shelf tucks under it, slightly inset. Mirrors
       * dimension's `ConnectIntegrationsBar` pattern. */}
      <div className="mt-8 w-full max-w-2xl">
        {/* Key by threadId so the composer (and its Tiptap editor) remounts
         * on thread switch — draft-seeding from localStorage runs once per
         * thread and the editor instance starts fresh, no per-render sync. */}
        <Composer
          key={threadId ?? "new"}
          threadId={threadId}
          isStreaming={isStreaming}
          onSend={onSend}
          autoApprove={autoApprove}
          autoApprovePending={autoApprovePending}
          onToggleAutoApprove={onToggleAutoApprove}
          tier={tier}
          onTierChange={onTierChange}
        />
        <ConnectToolsBar />
      </div>
    </div>
  );
}

function formatDate(date: Date): string {
  const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
  const month = date.toLocaleDateString(undefined, { month: "long" });
  const day = date.getDate();
  return `${weekday}, ${month} ${day}${ordinal(day)}`;
}

function ordinal(n: number): string {
  const s = n % 100;
  if (s >= 11 && s <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}
