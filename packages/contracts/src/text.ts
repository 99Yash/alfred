/** Display-text folds. Not in `sanitize.ts` because nothing here is a safety guard. */

/**
 * Collapse whitespace runs to one space and trim. Display text only: this may
 * change, so keys, hashes, and dedup tokens keep their own fold, as
 * `loop-key.ts`'s `normalizeSubject` does.
 */
export function collapseWhitespace(text: string): string {
  // drift-ok: the one definition the `hand-rolled-whitespace-collapse` rule names.
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Remove characters that have no width, such as U+034F, U+200B to U+200F, and
 * U+FEFF. Marketing mail pads its preheader with long runs of these characters
 * and spaces. Gmail copies the padding into the snippet, so a one-line preview
 * overflows on blank text and ends in an ellipsis. A ZWJ (U+200D) after an
 * emoji stays, because it joins an emoji sequence. Display text only, like
 * `collapseWhitespace`.
 */
export function stripInvisibleChars(text: string): string {
  return text
    .replace(/[\p{Default_Ignorable_Code_Point}--[‍]]/gv, "")
    .replace(/(?<!\p{Extended_Pictographic}[️\p{Emoji_Modifier}]?)‍/gu, "");
}

/**
 * A value as text for a reader: a string as it is, anything else as JSON. A
 * missing value reads as `null`, because `JSON.stringify(undefined)` returns
 * `undefined`, not a string. `indent` pretty-prints the JSON form for a block
 * display. Display text only, like `collapseWhitespace`.
 */
export function toDisplayText(value: unknown, indent?: number): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- display text renders an unknown value; a string shows as it is, and any other value shows as JSON.
  return typeof value === "string" ? value : JSON.stringify(value ?? null, null, indent);
}
