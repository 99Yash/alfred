/**
 * The CLI door to the price sync (`../model-prices-sync.ts`). `db:predeploy` runs it before each
 * production deploy. The server also runs the same sync daily.
 *
 *   $ pnpm --filter @alfred/db db:sync-prices
 */
import { toMessage } from "@alfred/contracts";
import { closeConnections } from "../index";
import { syncModelPrices } from "../model-prices-sync";

function safeCauseMessage(err: unknown): string | undefined {
  if (!(err instanceof Error) || !("cause" in err)) return undefined;
  const cause = err.cause;

  if (cause instanceof Error) return cause.message;

  return typeof cause === "string" ? cause : undefined;
}

try {
  console.log("[sync-prices] fetching models.dev…");
  const result = await syncModelPrices();
  console.log(`[sync-prices] ${result.fromCatalog} from models.dev + ${result.fromStatic} static`);
  console.log(`[sync-prices] inserted=${result.inserted} unchanged=${result.unchanged}`);
} catch (err) {
  console.error("[sync-prices] FAIL:", toMessage(err));
  const cause = safeCauseMessage(err);

  if (cause) console.error("[sync-prices] cause:", cause);
  process.exitCode = 1;
} finally {
  await closeConnections().catch(() => {});
}
