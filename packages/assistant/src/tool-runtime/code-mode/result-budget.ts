/**
 * The budget of one `system.code_run` result (ADR-0124: the full model-facing envelope stays
 * within its result budget). The parts add up to the total by construction: the guest value, the
 * sources, and a reserve for the status, the counts, and the keys. A failure carries a message
 * instead of a value, and the message cap is far below the value cap. The parts do not prove the
 * total (`run` measures its own encoding of the value), so `system.code_run` also checks the whole
 * envelope against {@link CODE_RUN_RESULT_MAX_BYTES} (ADR-0124 amendment 2026-11-18 (b)).
 */

import type { JsonValue } from "@alfred/contracts";
import { publicAppError, type PublicAppError } from "@alfred/contracts/app-errors";

/** The most JSON bytes of a `system.code_run` result. */
export const CODE_RUN_RESULT_MAX_BYTES = 64 * 1024;

/** The most JSON bytes that a script's sources keep. */
export const SCRIPT_SOURCES_MAX_BYTES = 8 * 1024;

/** The status, the read counts, `omittedSources`, and the keys. */
const RESULT_METADATA_MAX_BYTES = 1024;

/** The most bytes of the value that the script returns. `run` enforces it. */
export const SCRIPT_VALUE_MAX_BYTES =
  CODE_RUN_RESULT_MAX_BYTES - SCRIPT_SOURCES_MAX_BYTES - RESULT_METADATA_MAX_BYTES;

/**
 * The most characters of a failure message. A guest error message has no length limit of its own.
 * After the sanitizer, one character is at most 4 UTF-8 bytes, so the cap is far below the value
 * cap.
 */
export const SCRIPT_FAILURE_MESSAGE_MAX_CHARS = 1_000;

/**
 * The largest value that the host gives the guest, in JSON bytes (ADR-0124 amendment 2026-11-18
 * (b)). The bridge measures its own encoding against `run`'s 4 MiB host output limit, so this cap
 * stays well below it: a value under it always reaches the guest. Dispatch checks it before it
 * saves a nested result, and the host checks it again before it marks a read `executed`.
 */
export const HOST_READ_DELIVERY_MAX_BYTES = 1024 * 1024;

/** The named failure of a script read above {@link HOST_READ_DELIVERY_MAX_BYTES}. */
export function scriptReadTooLarge(bytes: number): PublicAppError {
  return publicAppError("script_read_output_too_large", {
    kib: Math.round(bytes / 1024),
    limitKib: HOST_READ_DELIVERY_MAX_BYTES / 1024,
  });
}

/** The UTF-8 bytes of a value's JSON, as the delivery cap and the result budget count them. */
export function jsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value));
}
