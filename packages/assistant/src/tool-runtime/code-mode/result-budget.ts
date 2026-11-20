/**
 * The size limits of one `system.code_run` result. The model reads a copy that the one size rule
 * bounds (ADR-0130 decision 5, `boundForModel` at the chat boundary), so the script value is not
 * cut here: the staging row keeps it whole, up to `run`'s own result cap.
 */

import type { JsonValue } from "@alfred/contracts";
import { publicAppError, type PublicAppError } from "@alfred/contracts/app-errors";

/** The most JSON bytes of the value that a script returns. `run` enforces it; it is `run`'s default. */
export const SCRIPT_VALUE_MAX_BYTES = 1024 * 1024;

/** The most JSON bytes that a script's sources keep. */
export const SCRIPT_SOURCES_MAX_BYTES = 8 * 1024;

/** The most characters of a failure message. A guest error message has no length limit of its own. */
export const SCRIPT_FAILURE_MESSAGE_MAX_CHARS = 1_000;

/**
 * The largest value that the host gives the guest, in JSON bytes (ADR-0124 amendment 2026-11-18
 * (b)). The bridge measures its own encoding against `run`'s 4 MiB host output limit, so this cap
 * stays well below it: a value under it always reaches the guest. Dispatch checks it before it
 * saves a nested result, and the host checks it again before it marks a read `executed`.
 */
export const HOST_READ_DELIVERY_MAX_BYTES = 1024 * 1024;

/**
 * The most JSON bytes of a stored result copy (a handle, or a direct read's own copy). It leaves
 * room under {@link HOST_READ_DELIVERY_MAX_BYTES} for the fields that `system.load_result` adds
 * (the handle, the tool, a query of at most 300 characters, and the fetch time), so one load
 * always delivers the whole stored copy.
 */
export const STORED_RESULT_MAX_BYTES = HOST_READ_DELIVERY_MAX_BYTES - 8 * 1024;

/** The named failure of a script read above {@link HOST_READ_DELIVERY_MAX_BYTES}. */
export function scriptReadTooLarge(bytes: number): PublicAppError {
  return publicAppError("script_read_output_too_large", {
    kib: Math.round(bytes / 1024),
    limitKib: HOST_READ_DELIVERY_MAX_BYTES / 1024,
  });
}

/** The UTF-8 bytes of a value's JSON, as the delivery cap counts them. */
export function jsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value));
}
