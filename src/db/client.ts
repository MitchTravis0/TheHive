import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

/** True when a D1 error (possibly wrapped by Drizzle) is a UNIQUE/PK violation on `target`. */
export function isUniqueViolation(error: unknown, target: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current.message.includes("UNIQUE constraint failed") && current.message.includes(target)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
