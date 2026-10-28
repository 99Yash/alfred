// Zone-aware formatting belongs with its domain hook, not here.

export function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export function lowerFirst(value: string): string {
  return value.length > 0 ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}
