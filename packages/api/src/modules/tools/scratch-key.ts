export type ScratchToolKey =
  | { key: string; zone: "shared"; path: string }
  | { key: string; zone: "scratch"; subId: string; path: string };

export function parseScratchToolKey(key: string): ScratchToolKey {
  const parts = key.split(".");
  if (parts[0] === "shared" && parts.length === 2) {
    const path = requireScratchPart("path", parts[1]);
    return { key, zone: "shared", path };
  }

  if (parts[0] === "scratch" && parts.length === 3) {
    const subId = requireScratchPart("subId", parts[1]);
    const path = requireScratchPart("path", parts[2]);
    return { key, zone: "scratch", subId, path };
  }

  throw new Error("Scratch key must be shared.<path> or scratch.<subId>.<path>");
}

function requireScratchPart(name: string, value: string | undefined): string {
  if (!value || value.includes(":")) {
    throw new Error(`Scratch key ${name} must be non-empty and contain no ':'`);
  }
  return value;
}
