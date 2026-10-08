import { authClient } from "~/lib/auth/auth-client";
import { firstName, greeting } from "~/lib/user-display";
import { Composer } from "./composer/composer";
import type { ChatModelTier } from "@alfred/contracts";
import { ConnectToolsBar } from "./connect-tools-bar";
import type { QueuedMessage } from "~/lib/chat/use-chat-queue";

export function EmptyHero({
  threadId,
  isStreaming,
  onSend,
  autoApprove,
  autoApprovePending,
  onToggleAutoApprove,
  tier,
  onTierChange,
  queued,
  onRemoveQueued,
}: {
  threadId: string | undefined;
  isStreaming: boolean;
  onSend?:
    | ((text: string, files?: File[], artifactTargetId?: string) => Promise<boolean>)
    | undefined;
  autoApprove?: boolean | undefined;
  autoApprovePending?: boolean | undefined;
  onToggleAutoApprove?: (() => void) | undefined;
  tier: ChatModelTier;
  onTierChange: (tier: ChatModelTier) => void;
  queued?: QueuedMessage[] | undefined;
  onRemoveQueued?: ((id: string) => void) | undefined;
}) {
  const { data: session } = authClient.useSession();
  const name = firstName(session?.user);
  const now = new Date();

  // Center greeting, composer, and connect bar as one block.
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

      {/* The connect bar tucks under the composer as one control. */}
      <div className="mt-8 w-full max-w-2xl">
        {/* Keyed by threadId so the editor remounts and seeds its draft once per thread. */}
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
          queued={queued}
          onRemoveQueued={onRemoveQueued}
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
