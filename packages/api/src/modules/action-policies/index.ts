import type { IntegrationRules } from "@alfred/contracts";
import { db } from "@alfred/db";
import { userActionPolicies } from "@alfred/db/schemas";
import { sql } from "drizzle-orm";

export const DEFAULT_APPROVAL_NOTIFY_DELAY_MS = 5 * 60 * 1000;

export {
  getResolvedPolicy,
  resolvePolicyMode,
  resolveApprovalNotifyDelayMs,
  bustPolicyCache,
  clearPolicyCacheForTests,
  publishPolicyBust,
  startPolicyBustSubscriber,
  stopPolicyBustSubscriber,
  type ResolvedPolicy,
} from "./resolve";

const DEFAULT_INTEGRATION_RULES = {
  system: { mode: "autonomy" },
} satisfies IntegrationRules;

export async function ensureDefaultActionPolicyForUser(userId: string): Promise<void> {
  await db()
    .insert(userActionPolicies)
    .values({
      userId,
      defaultMode: "gated",
      integrationRules: DEFAULT_INTEGRATION_RULES,
      approvalNotifyDelayMs: DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
    })
    .onConflictDoUpdate({
      target: userActionPolicies.userId,
      set: {
        // Keep this hook idempotent without trampling user changes. The
        // conflict path only proves the row still conforms to the m13
        // baseline and refreshes updated_at for audit visibility.
        updatedAt: sql`now()`,
      },
    });
}
