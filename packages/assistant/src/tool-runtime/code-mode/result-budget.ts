/**
 * The budget of one `system.code_run` result (ADR-0124: the full model-facing envelope stays
 * within its result budget). The parts add up to the total by construction: the guest value, the
 * sources, and a reserve for the status, the counts, and the keys. A failure carries a message
 * instead of a value, and the message cap is far below the value cap.
 */

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
