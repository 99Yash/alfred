/** Public error behavior is registered once; arbitrary exception text never crosses a boundary. */
export const APP_ERROR_REGISTRY = {
  artifact_create_failed: {
    message: "Saving the artifact failed; nothing was created.",
  },
  calendar_connection_required: {
    message: "Calendar is not connected with write access. Reconnect Calendar in settings.",
  },
  calendar_bounds_conflict: {
    message:
      "Calendar accepts either explicit timeMin/timeMax bounds or a relative window, not both.",
  },
  calendar_bounds_order: {
    message: "Calendar requires timeMax to be after timeMin.",
  },
  gmail_connection_required: {
    message: "Gmail is not connected. Reconnect Gmail in settings.",
  },
  gmail_scope_required: {
    message:
      "The connected Google account does not grant Gmail access. Reconnect with Gmail enabled.",
  },
  tool_execution_failed: {
    message: "The tool failed unexpectedly. Please try again.",
  },
} as const;

export type AppErrorCode = keyof typeof APP_ERROR_REGISTRY;
export type PublicAppError = { code?: AppErrorCode; message: string };

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === "string" && value in APP_ERROR_REGISTRY;
}

export class AppError extends Error {
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode, options?: ErrorOptions) {
    super(APP_ERROR_REGISTRY[code].message, options);
    this.name = "AppError";
    this.code = code;
  }
}

export function toPublicAppError(
  err: unknown,
  fallback: AppErrorCode = "tool_execution_failed",
): PublicAppError {
  const code = err instanceof AppError ? err.code : fallback;
  return { code, message: APP_ERROR_REGISTRY[code].message };
}
