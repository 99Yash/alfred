import { serverEnv } from "@alfred/env/server";
import { Resend } from "resend";

/**
 * Cached Resend client. `@alfred/auth` keeps its own for OTP mail, which keeps the import graph acyclic.
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
