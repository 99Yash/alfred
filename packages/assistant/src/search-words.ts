/** Word folds for assistant tool search. Match keys only, never display text. */

/** A naive English singular, so a query matches either number ("issues" and "issue"). */
export function singularizeWord(word: string): string {
  if (word.length <= 3) return word;

  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;

  if (/(ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);

  if (word.endsWith("s") && !/(ss|us|is|ous)$/.test(word)) return word.slice(0, -1);

  return word;
}

/**
 * Singularize each word, so "pull requests" matches "pull request" (#414).
 * Expects a normalized, single-spaced string.
 */
export function singularizePhrase(value: string): string {
  return value.split(" ").map(singularizeWord).join(" ");
}
