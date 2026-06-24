import { serverEnv } from "@alfred/env/server";

/**
 * The server-held HMAC namespace secret for stable entity ids (ADR-0067 D2).
 *
 * `ENTITY_ID_NAMESPACE` is `optional` in `serverEnv` because P0 ships no writer —
 * requiring it at boot would break every environment that doesn't mint ids yet.
 * But a P1+ writer must NEVER mint with a blank key: `computeStableEntityId` keys
 * the HMAC off this secret, and an absent/empty key produces ids no harder to
 * guess than the raw SHA the HMAC exists to avoid (and a later configured key
 * would re-mint every content-addressed id). So fail loud HERE — at the one
 * accessor every writer routes through — rather than let a caller fall back to
 * `serverEnv().ENTITY_ID_NAMESPACE ?? ""`.
 *
 * The env validator already enforces ≥32 chars + no surrounding whitespace when
 * the value is present (`optionalLongSecret`), and `computeStableEntityId`
 * re-checks the same at the mint chokepoint; this guards only presence.
 */
export function requireEntityIdNamespace(): string {
  const secret = serverEnv().ENTITY_ID_NAMESPACE;
  if (!secret) {
    throw new Error(
      "ENTITY_ID_NAMESPACE is not configured — refusing to mint stable entity ids (ADR-0067 D2). " +
        "Set it (>=32 chars, no surrounding whitespace, backed up like an auth secret — changing it " +
        "re-mints every content-addressed entity id on replay) before running any user-model projection writer.",
    );
  }
  return secret;
}
