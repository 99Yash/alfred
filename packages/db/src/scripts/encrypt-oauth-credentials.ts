/**
 * One-time encryption of stored OAuth tokens.
 *
 *   pnpm db:encrypt-credentials:check   # report, write nothing
 *   pnpm db:encrypt-credentials         # convert, then verify
 *
 * Stop every server and worker first. An old process reads the tokens as plaintext.
 * Not part of `db:predeploy` for that reason. See `docs/runbooks/oauth-credential-vault-rollout.md`.
 */
import { toMessage } from "@alfred/contracts";
import { closeConnections } from "../index";
import { encryptPersistedOAuthCredentials } from "../credential-vault-maintenance";

async function main() {
  const checkOnly = process.argv.includes("--check");
  const mode = checkOnly ? "check" : "convert";
  console.log(`[encrypt-oauth-credentials] mode=${mode}`);

  const result = await encryptPersistedOAuthCredentials({ checkOnly });
  console.log(`  account rows updated:                ${result.accountsUpdated}`);
  console.log(`  integration_credentials rows updated: ${result.integrationsUpdated}`);
  console.log(`  plaintext token fields remaining:     ${result.plaintextRemaining}`);
  console.log(`  unopenable token fields remaining:    ${result.unopenableRemaining}`);

  if (result.plaintextRemaining > 0) {
    console.error(
      checkOnly
        ? "  → not yet converted. Stop all writers, then run without --check."
        : "  → conversion did not reach zero. Do NOT start the application.",
    );
    process.exitCode = 1;

    return;
  }

  if (result.unopenableRemaining > 0) {
    // Sealed under another key. A conversion would skip them, so the fix is different.
    console.error(
      "  → sealed under a different key. Restore the key that wrote them, or rewrap; see the runbook's rotation section.",
    );
    process.exitCode = 1;

    return;
  }

  console.log("  → every persisted OAuth token is sealed and opens with the configured key.");
}

main()
  .catch((err) => {
    console.error(`[encrypt-oauth-credentials] failed: ${toMessage(err)}`);
    process.exitCode = 1;
  })
  .finally(closeConnections);
