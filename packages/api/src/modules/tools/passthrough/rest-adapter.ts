import {
  toMessage,
  type PassthroughResult,
  type RestPassthroughRequest,
  type SupportedRestSlug,
} from "@alfred/contracts";
import {
  PassthroughUrlError,
  restPassthroughFetch,
  type RestPassthroughProfile,
} from "@alfred/integrations/shared";
import { REST_GATE_CONFIG } from "./config";
import { assertReadableRestRequest } from "./gate";
import {
  passthroughBinaryResult,
  passthroughHttpResult,
  passthroughRejection,
  passthroughTransportError,
} from "./shaper";
import { classifyTransportError } from "./transport";

/**
 * The one REST passthrough adapter shared by every REST provider (`github`,
 * `notion`, `vercel`, and the Google family) in the general read-only tier
 * (ADR-0074 rung-a). Composes the whole security boundary for a raw REST read:
 *
 *   read gate (method/path proven a read) → pinned-authority transport → honest envelope.
 *
 * The tool `execute` stays thin (resolve credential → build the provider profile
 * → this); every network and shaping concern lives here so the contract is
 * testable with a mocked `fetch`. Returns a {@link PassthroughResult} for every
 * outcome and NEVER throws:
 * - a gate denial is a visible `rejected` envelope (the boss self-corrects);
 * - a URL that escapes the pinned namespace is a fail-closed `invalid_path`
 *   rejection (the request never left Alfred — not a transport failure);
 * - a transport failure (timeout/DNS/reset/TLS) is a classified `transport`
 *   envelope; and any HTTP response (including 4xx/5xx) is the honest `http`
 *   envelope with the real status and body.
 */
export async function runRestPassthrough(
  slug: SupportedRestSlug,
  profile: RestPassthroughProfile,
  request: RestPassthroughRequest,
): Promise<PassthroughResult> {
  const gate = assertReadableRestRequest(REST_GATE_CONFIG[slug], request);
  if (!gate.ok) return passthroughRejection(gate);

  let raw;
  try {
    raw = await restPassthroughFetch(profile, request);
  } catch (err) {
    if (err instanceof PassthroughUrlError) {
      // The constructed URL left the pinned namespace — a fail-closed rejection
      // (the request never left Alfred), never a masqueraded transport error.
      return passthroughRejection({ ok: false, reason: "invalid_path", detail: err.message });
    }
    return passthroughTransportError(classifyTransportError(err), toMessage(err));
  }

  if (raw.binary) {
    return passthroughBinaryResult({
      status: raw.status,
      contentType: raw.contentType,
      byteCount: raw.byteCount,
    });
  }

  // A 3xx is an HTTP outcome, not a hop (redirects are never followed). Surface
  // the redacted origin+path so the boss sees the redirect instead of an opaque
  // empty body; `passthroughHttpResult` already marks a 3xx `succeeded: false`.
  const body =
    raw.redirectedTo !== undefined ? { redirect: true, location: raw.redirectedTo } : raw.body;
  return passthroughHttpResult({ status: raw.status, body });
}
