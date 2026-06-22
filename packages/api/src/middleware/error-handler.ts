import { Elysia } from "elysia";
import { ApiError, apiErrorResponse, type ApiErrorResponse } from "./errors.js";
import { toMessage } from "@alfred/contracts";

export const errorHandler = new Elysia({ name: "error-handler", normalize: "typebox" }).onError(
  { as: "global" },
  ({ code, error, set }) => {
    if (error instanceof ApiError) {
      set.status = error.statusCode;
      return apiErrorResponse(error);
    }

    if (code === "VALIDATION") {
      set.status = 400;
      const first = error.all[0];
      const summary = first?.summary ? `Validation failed: ${first.summary}` : "Validation failed";
      return apiError(summary, "VALIDATION_ERROR");
    }

    if (code === "NOT_FOUND") {
      set.status = 404;
      return apiError("Not found", "NOT_FOUND");
    }

    if (code === "PARSE") {
      set.status = 400;
      return apiError("Invalid request body", "PARSE_ERROR");
    }

    console.error("[api] Unhandled error:", toMessage(error));
    set.status = 500;
    return apiError("Internal server error", "INTERNAL_SERVER_ERROR");
  },
);

function apiError(error: string, code: ApiErrorResponse["code"]): ApiErrorResponse {
  return { error, code };
}
