import { Elysia } from "elysia";
import { ApiError } from "./errors.js";

export const errorHandler = new Elysia({ name: "error-handler", normalize: "typebox" }).onError(
  { as: "global" },
  ({ code, error, set }) => {
    if (error instanceof ApiError) {
      set.status = error.statusCode;
      return { error: error.message, code: error.code };
    }

    if (code === "VALIDATION") {
      set.status = 400;
      const first = error.all[0];
      const summary = first?.summary ? `Validation failed: ${first.summary}` : "Validation failed";
      return { error: summary, code: "VALIDATION_ERROR" };
    }

    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "Not found", code: "NOT_FOUND" };
    }

    if (code === "PARSE") {
      set.status = 400;
      return { error: "Invalid request body", code: "PARSE_ERROR" };
    }

    console.error("[api] Unhandled error:", error instanceof Error ? error.message : String(error));
    set.status = 500;
    return { error: "Internal server error", code: "INTERNAL_SERVER_ERROR" };
  },
);
