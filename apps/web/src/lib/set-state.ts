import type { SetStateAction } from "react";

/** The `typeof` lives in this guard, which the lint rule allows. */
export function isStateUpdater<T>(value: SetStateAction<T>): value is (previous: T) => T {
  return typeof value === "function";
}

/** React's setState resolution, for reducers. */
export function resolveSetState<T>(current: T, next: SetStateAction<T>): T {
  return isStateUpdater(next) ? next(current) : next;
}
