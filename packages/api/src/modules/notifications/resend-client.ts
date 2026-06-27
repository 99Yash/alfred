import { serverEnv } from "@alfred/env/server";
import { Resend } from "resend";

/**
 * Process-wide Resend client. The `Resend` constructor is a thin wrapper
 * around `fetch` with no socket pool worth sharing, but we cache the
 * instance anyway to avoid re-reading env + re-allocating on every send.
 *
 * `@alfred/auth` keeps its own client for the OTP path — they share the
 * same `RESEND_API_KEY` via `serverEnv()` but live in different
 * dependency trees, and a singleton-by-package keeps the import graph
 * acyclic.
 */
let _client: Resend | undefined;

export function getResendClient(): Resend {
  if (_client) return _client;
  _client = new Resend(serverEnv().RESEND_API_KEY);
  return _client;
}

export function _setResendClientForTests(client: Resend | undefined): void {
  _client = client;
}
