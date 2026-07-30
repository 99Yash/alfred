/**
 * Maintenance command for the one-time OAuth credential encryption (#453).
 *
 *   pnpm db:encrypt-credentials:check   # report, write nothing
 *   pnpm db:encrypt-credentials         # convert, then verify
 *
 * **Stop every writer first.** This rewrites `account` and
 * `integration_credentials` token columns in place. A server or worker that is
 * still running reads those columns as plaintext, so it would either send an
 * envelope to a provider as a bearer token or write a fresh plaintext token
 * after the verification passed.
 *
 * Deliberately NOT part of `db:predeploy`. Migrations run while the old release
 * is still serving; this must not.
 *
 * Full procedure, including key generation and rollback limits:
 * `docs/runbooks/oauth-credential-vault-rollout.md`.
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
    // In check mode before the rollout this is the expected, informative answer;
    // after a convert run it means the pass missed something. Either way a
    // non-zero exit keeps it out of a green deploy pipeline.
    console.error(
      checkOnly
        ? "  → not yet converted. Stop all writers, then run without --check."
        : "  → conversion did not reach zero. Do NOT start the application.",
    );
    process.exitCode = 1;
    return;
  }
  if (result.unopenableRemaining > 0) {
    // Reported separately because the fix is different: these rows ARE sealed,
    // just not under OAUTH_CREDENTIAL_KEK as configured. Folding them into the
    // plaintext count would send the operator to run a conversion that skips
    // every one of them.
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
