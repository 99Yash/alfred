import { toMessage, type PassthroughResult, type RestPassthroughRequest } from "@alfred/contracts";
import { PassthroughUrlError, type RestPassthroughCapability } from "@alfred/integrations/shared";
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
 * The REST passthrough read for every REST provider (ADR-0074): read gate, then
 * pinned-origin transport, then the result envelope. Never throws.
 */
export async function runRestPassthrough(
  capability: RestPassthroughCapability,
  request: RestPassthroughRequest,
): Promise<PassthroughResult> {
  const gate = assertReadableRestRequest(REST_GATE_CONFIG[capability.slug], request);

  if (!gate.ok) return passthroughRejection(gate);

  let raw;

  try {
    raw = await capability.execute(request);
  } catch (err) {
    if (err instanceof PassthroughUrlError) {
      // The request never left Alfred, so this is a rejection, not a transport error.
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

  // Redirects are never followed. Show the redacted target instead of an empty body.
  const body =
    raw.redirectedTo !== undefined ? { redirect: true, location: raw.redirectedTo } : raw.body;

  return passthroughHttpResult({ status: raw.status, body });
}
