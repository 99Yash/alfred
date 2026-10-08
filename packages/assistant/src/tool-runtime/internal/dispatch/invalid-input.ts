import { z } from "zod";
import type { JsonObject } from "@alfred/contracts";

// Runs on every dispatch, and `z.toJSONSchema` walks the whole schema, so memoize per schema.
const acceptedParamCache = new WeakMap<z.ZodType<any>, readonly string[]>();

export function acceptedParamNames(schema: z.ZodType<any>): readonly string[] {
  const cached = acceptedParamCache.get(schema);

  if (cached) return cached;
  let names: readonly string[];

  try {
    // SAFETY: reads only the top-level `properties` of a JSON Schema document.
    const json = z.toJSONSchema(schema, { io: "input" }) as {
      properties?: JsonObject;
    };

    names = json.properties ? Object.freeze(Object.keys(json.properties)) : EMPTY;
  } catch {
    names = EMPTY;
  }

  acceptedParamCache.set(schema, names);

  return names;
}

const EMPTY: readonly string[] = Object.freeze([]);

/** A bare `Unrecognized key` says what is wrong, so add the accepted names. Never throws. */
export function enrichInvalidInputMessage(
  baseMessage: string,
  schema: z.ZodType<any>,
  issues: readonly { code?: string }[],
): string {
  if (!issues.some((issue) => issue.code === "unrecognized_keys")) return baseMessage;
  const accepted = acceptedParamNames(schema);

  if (accepted.length === 0) return baseMessage;

  return `${baseMessage}\nThis tool accepts only these parameters: ${accepted.join(", ")}.`;
}
