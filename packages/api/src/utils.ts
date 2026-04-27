// Shared route utilities
export function firstOrNull<T>(arr: T[]): T | null {
  return arr[0] ?? null;
}
