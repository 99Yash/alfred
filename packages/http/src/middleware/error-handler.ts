import { logger } from "@alfred/logging";
import { ApiError, apiErrorResponse, Errors } from "@alfred/contracts";
import { Elysia, ValidationError } from "elysia";

export const errorHandler = new Elysia({ name: "error-handler", normalize: "typebox" }).onError(
  { as: "global" },
  ({ code, error, set }) => {
    const respond = (apiError: ApiError) => {
      set.status = apiError.statusCode;

      return apiErrorResponse(apiError);
    };

    if (error instanceof ApiError) return respond(error);

    if (code === "VALIDATION") {
      // A query `t.Array` decodes through a TypeBox Transform (`ArrayQuery`): a bad item
      // throws `TransformDecodeCheckError`, which Elysia reports with code "VALIDATION"
      // but no `.all` list. Reading `.all` unconditionally throws inside `onError`, so
      // the node adapter never answers. Only `ValidationError` carries `.all`.
      const first = error instanceof ValidationError ? error.all[0] : undefined;
      const summary = first?.summary ? `Validation failed: ${first.summary}` : undefined;

      return respond(Errors.ValidationError(summary));
    }

    if (code === "NOT_FOUND") return respond(Errors.NotFoundError());

    if (code === "PARSE") return respond(Errors.ParseError());

    logger.error({ err: error }, "[api] Unhandled error");

    return respond(Errors.InternalServerError());
  },
);
