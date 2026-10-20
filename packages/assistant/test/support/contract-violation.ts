/**
 * A value that breaks its declared type on purpose, typed as that type.
 * Use it only to feed a runtime parse or guard that the test proves rejects the value,
 * for example an adapter result outside its schema or a tier outside its union.
 */
export function asContractViolation<T>(value: unknown): T {
  // SAFETY: the precondition above: the value is wrong on purpose, and the code under test must reject it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a wrong value on purpose
  return value as T;
}
