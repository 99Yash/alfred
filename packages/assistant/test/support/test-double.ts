/**
 * A partial stand-in typed as the full interface, for a large SDK, client, model, or `tx` type.
 * Use it only when the code under test reads the provided members and no others.
 * A member that the code reads but the partial leaves out is `undefined` at runtime.
 *
 * It checks member names, not member types: Drizzle builders have generic and private members,
 * and a fake that implements one call chain cannot satisfy them.
 */
export function asTestDouble<T>(partial: { readonly [K in keyof T]?: unknown }): T {
  // SAFETY: the precondition above: the code under test reads only the members in `partial`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a test double; the code under test reads only these members
  return partial as T;
}
