import { sql } from "drizzle-orm";
import { customType, timestamp } from "drizzle-orm/pg-core";
import { customAlphabet } from "nanoid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const lifecycle_dates = {
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .default(sql`current_timestamp`)
    .$onUpdate(() => new Date()),
};

export function createId(prefix?: string, { length = 12, separator = "_" } = {}): string {
  const id = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", length)();
  return prefix ? `${prefix}${separator}${id}` : id;
}

export function generateRandomCode(length: number = 8) {
  return customAlphabet("123456789", length)();
}

export function firstOrNull<T>(rows: T[]): T | null {
  return rows[0] ?? null;
}

/**
 * Shortest text that round-trips to the same float32 pgvector stores.
 * Embedding providers return JS numbers, but pgvector stores vector
 * elements as float32, so sending float64-precision text only wastes
 * bandwidth on writes and query literals.
 */
export function formatFloat32(value: number): string {
  return Number(Math.fround(value).toPrecision(9)).toString();
}

export function formatVectorFloat32(values: number[]): string {
  return `[${values.map(formatFloat32).join(",")}]`;
}

/**
 * pgvector column wrapper. `toDriver` serializes `number[]` as a
 * float32-precision `[a,b,c]` literal pgvector accepts on insert;
 * `fromDriver` parses the same shape back so callers receive
 * `number[]` directly.
 *
 * All embeddings in alfred are 1024-dim (ADR-0021); use this helper
 * for any new vector column.
 */
export const vectorColumn = (name: string, dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return formatVectorFloat32(value);
    },
    fromDriver(value: string): number[] {
      return JSON.parse(value) as number[];
    },
  })(name);
