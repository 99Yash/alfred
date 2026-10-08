import { serverEnv } from "@alfred/env/server";

/**
 * The HMAC secret for stable entity ids (ADR-0067 D2). The env field is optional,
 * so this throws when it is absent: a blank key mints guessable ids.
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
