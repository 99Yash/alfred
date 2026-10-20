// This file has one byte-identical copy in each of `packages/{assistant,auth,http,integrations}/test/support/`.
// Edit all four together.

/** One step down the depth budget of `TestDoubleOf`. At `never` the budget is spent. */
type OneLess = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/**
 * What a fake may hold where the real type is `V`, checked as deep as `Depth` levels:
 *
 * - A function member must be a function. The real arguments must fit its parameters, so a fake
 *   with an extra required parameter or a narrower parameter type fails. Its return is checked
 *   by the same rule. For an overloaded member, TypeScript reads the last overload; for a
 *   generic member, it reads each type parameter as its constraint.
 * - A promise or other thenable must resolve to a fake of the resolved type. A builder that is
 *   also a thenable (a Drizzle query) may instead be a fake of its members with no `then`.
 * - An object member is itself a partial fake: each member is optional and checked by this rule.
 * - A primitive member must have the real type.
 *
 * Below the depth budget nothing is checked. The budget stops the recursion on self-referential
 * builder types, which would otherwise exceed the compiler's instantiation limit.
 */
type TestDoubleOf<V, Depth extends number = 12> = [Depth] extends [never]
  ? unknown
  : V extends (...args: infer Args) => infer Result
    ? (...args: Args) => TestDoubleOf<Result, OneLess[Depth]>
    : V extends PromiseLike<infer Resolved>
      ?
          | PromiseLike<TestDoubleOf<Resolved, OneLess[Depth]>>
          | ({ readonly [K in keyof V]?: TestDoubleOf<V[K], OneLess[Depth]> } & {
              readonly then?: never;
            })
      : V extends object
        ? { readonly [K in keyof V]?: TestDoubleOf<V[K], OneLess[Depth]> }
        : V;

/**
 * A partial stand-in typed as the full interface, for a large SDK, client, model, or `tx` type.
 * Use it only when the code under test reads the provided members and no others.
 * A member that the code reads but the partial leaves out is `undefined` at runtime.
 *
 * It checks the type of each member that the partial provides (see `TestDoubleOf`), so a fake
 * with a wrong return type, a wrong parameter, or a value where a function belongs fails
 * `check-types`.
 */
export function asTestDouble<T>(partial: TestDoubleOf<T>): T {
  // SAFETY: the precondition above: the code under test reads only the members in `partial`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a test double; the code under test reads only these members
  return partial as T;
}

/**
 * `asTestDouble` with member names checked but member types not checked.
 * Use it only when an honest fake cannot have the real member types, and say why at the call:
 * a foreign thenable that stands in for a `Promise` but is not one, or an in-memory Replicache
 * transaction whose plain-value store cannot satisfy the generic `get`.
 */
export function asUncheckedTestDouble<T>(partial: { readonly [K in keyof T]?: unknown }): T {
  // SAFETY: the precondition above: the code under test reads only the members in `partial`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a test double; the code under test reads only these members
  return partial as T;
}
