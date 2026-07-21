import type { PassthroughResult, RestPassthroughRequest } from "@alfred/contracts";
import { googlePassthroughProfile, type GoogleService } from "@alfred/integrations/google";
import { runRestPassthrough } from "./rest-adapter";

/**
 * Runs a Google passthrough read with one service value controlling both the
 * read gate and the pinned Google API namespace. Keeping those inputs coupled
 * prevents a copied tool registration from pairing one service's gate with
 * another service's authority profile.
 */
export function runGooglePassthrough(
  service: GoogleService,
  accessToken: string,
  request: RestPassthroughRequest,
): Promise<PassthroughResult> {
  return runRestPassthrough(service, googlePassthroughProfile(service, accessToken), request);
}
