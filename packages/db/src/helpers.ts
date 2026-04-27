import { sql } from 'drizzle-orm';
import { timestamp } from 'drizzle-orm/pg-core';
import { customAlphabet } from 'nanoid';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const lifecycle_dates = {
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .default(sql`current_timestamp`)
    .$onUpdate(() => new Date()),
};

export function createId(
  prefix?: string,
  { length = 12, separator = '_' } = {}
): string {
  const id = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', length)();
  return prefix ? `${prefix}${separator}${id}` : id;
}

export function generateRandomCode(length: number = 8) {
  return customAlphabet('123456789', length)();
}

export function firstOrNull<T>(rows: T[]): T | null {
  return rows[0] ?? null;
}
