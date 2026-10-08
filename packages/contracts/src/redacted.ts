/**
 * Carry a secret without leaking it to logs, errors, or JSON.
 * String, JSON, and `console.log` all print a mask, and the private field is
 * not an own property. Only `unwrap()` returns the plaintext: call it at the wire.
 * A class instance, so `isRecord` rejects it.
 */
export class Redacted<T = string> {
  readonly _tag = "Redacted" as const;
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  unwrap(): T {
    return this.#value;
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "Redacted([redacted])";
  }
}

export function redacted<T>(value: T): Redacted<T> {
  return new Redacted(value);
}

export function isRedacted(value: unknown): value is Redacted {
  return value instanceof Redacted;
}
