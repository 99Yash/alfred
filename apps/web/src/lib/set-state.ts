import type { SetStateAction } from "react";

/**
 * Narrow the callable (updater) arm of a `SetStateAction`. The `typeof` lives
 * here, inside the predicate — which `allowInTypeGuards` permits — so the
 * reducer and hook call sites stay `typeof`-free without a cast.
 */
export function isStateUpdater<T>(value: SetStateAction<T>): value is (previous: T) => T {
  return typeof value === "function";
}

/**
 * Resolve a `SetStateAction` against its current value — the reducer's
 * equivalent of React's own setState resolution.
 */
export function resolveSetState<T>(current: T, next: SetStateAction<T>): T {
  return isStateUpdater(next) ? next(current) : next;
}
