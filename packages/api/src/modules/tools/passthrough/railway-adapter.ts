import {
  getPath,
  toMessage,
  type GraphqlPassthroughRequest,
  type PassthroughResult,
} from "@alfred/contracts";
import { railwayGraphqlRaw } from "@alfred/integrations/railway";
import { assertReadableGraphqlRequest } from "./gate";
import { passthroughHttpResult, passthroughRejection, passthroughTransportError } from "./shaper";
import { classifyTransportError } from "./transport";

/**
 * Railway's general read-only passthrough adapter (ADR-0074 rung-a). The one
 * place that composes the security boundary for a raw Railway GraphQL read:
 *
 *   read gate (AST proves query-only) → raw transport → honest envelope.
 *
 * The tool `execute` stays thin (resolve credential → this); every network and
 * shaping concern lives here so the transport contract is testable with a mocked
 * `railwayGraphqlRaw`. Returns a {@link PassthroughResult} for every outcome and
 * never throws: a gate denial is a visible `rejected` envelope, a transport
 * failure is classified into a `transport` envelope, and any HTTP response
 * (including GraphQL `errors[]`) is the honest `http` envelope.
 */
export async function runRailwayPassthrough(
  token: string,
  request: GraphqlPassthroughRequest,
): Promise<PassthroughResult> {
  const gate = assertReadableGraphqlRequest(request);
  if (!gate.ok) return passthroughRejection(gate);

  let raw;
  try {
    raw = await railwayGraphqlRaw(token, request);
  } catch (err) {
    return passthroughTransportError(classifyTransportError(err), toMessage(err));
  }

  // GraphQL can return HTTP 200 with a non-empty `errors[]` (or `data` + errors,
  // a partial). The shaper marks `succeeded: false` on any errors[] while keeping
  // the partial `data` in the body — the rubric tells the model to read both.
  const errors = getPath(raw.body, "errors");
  const graphqlHasErrors = Array.isArray(errors) && errors.length > 0;

  return passthroughHttpResult({
    status: raw.status,
    body: raw.body,
    graphqlHasErrors,
  });
}
