/**
 * A value that must never accidentally reach a log, an error message, or a
 * serialized payload. The lightweight local answer to Effect's `Redacted` — it
 * exists so a credential can be *carried* through code without being *exposed*
 * by the default ways values leak:
 *
 *   - `String(secret)` / template interpolation → `"[redacted]"`
 *   - `JSON.stringify({ secret })`               → `"[redacted]"` (via toJSON)
 *   - `console.log(secret)` (Node)               → `Redacted([redacted])`
 *   - the private field never appears on the instance, so a structured logger
 *     that enumerates own properties finds nothing to print.
 *
 * The plaintext is reachable only through the explicit {@link Redacted.unwrap}
 * call, so every place that actually needs the secret is greppable and visible
 * at the call site (the intended single place being the moment a header is set
 * on the outbound request). Wrapping a token at the credential boundary and
 * unwrapping only at the wire is what lets "pristine security" be a property of
 * the types rather than a review-time discipline.
 *
 * A `Redacted` is deliberately a class instance, so `isRecord` rejects it — a
 * secret is not JSON-shaped data and must not be treated as such.
 */
export class Redacted<T = string> {
  readonly _tag = "Redacted" as const;
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /**
   * The one explicit door back to the plaintext. Every read is greppable and
   * visible at its call site; there is no implicit path.
   */
  unwrap(): T {
    return this.#value;
  }

  /** Interpolation / `String(x)` never leak the secret. */
  toString(): string {
    return "[redacted]";
  }

  /** `JSON.stringify` uses this, so a secret in a logged payload is masked. */
  toJSON(): string {
    return "[redacted]";
  }

  /** `console.log` / `util.inspect` in Node never print the plaintext. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "Redacted([redacted])";
  }
}

/** Wrap a plaintext secret so it can be carried but not accidentally exposed. */
export function redacted<T>(value: T): Redacted<T> {
  return new Redacted(value);
}

/** Type guard — a carried secret, distinguished by its tag rather than shape. */
export function isRedacted(value: unknown): value is Redacted {
  return value instanceof Redacted;
}
