import { z } from "zod";
import { HiveError } from "../errors";
import { fromBase64Url, toBase64Url, utf8 } from "./encoding";

/**
 * Token budgets and cursors (BUILD_PLAN section 8). Lists are cut at item boundaries, never
 * mid-item, and return a cursor for the rest. Tokens are estimated as ceil(chars / 4).
 */

export const DEFAULT_READ_TOKENS = 4000;
export const DEFAULT_PULSE_TOKENS = 1500;
/** Upper bound on rows fetched for one page, whatever the token budget. */
export const PAGE_ROWS = 50;

export const listInput = {
  cursor: z.string().max(300).optional().describe("Opaque cursor from a previous response."),
  max_tokens: z.coerce
    .number()
    .int()
    .min(200)
    .max(20_000)
    .optional()
    .describe("Approximate token budget for the response."),
};

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

/**
 * Takes items from the front until the budget is used. Always takes at least one item if there
 * is one, so a page can never be empty while more remain.
 */
export function takeWithinBudget<T>(
  items: T[],
  maxTokens: number,
): { taken: T[]; used: number; cut: boolean } {
  const taken: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = estimateTokens(item);
    if (taken.length > 0 && used + cost > maxTokens) return { taken, used, cut: true };
    taken.push(item);
    used += cost;
  }
  return { taken, used, cut: false };
}

export function encodeCursor(value: Record<string, string | number>): string {
  return toBase64Url(utf8(JSON.stringify(value)));
}

export function decodeCursor<S extends z.ZodType>(
  cursor: string | undefined,
  schema: S,
): z.output<S> | null {
  if (cursor === undefined) return null;
  const bytes = fromBase64Url(cursor);
  try {
    if (bytes) return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    // fall through to the teaching error
  }
  throw new HiveError(
    400,
    "invalid_cursor",
    "The cursor is not one this endpoint issued.",
    "Pass next_cursor from the previous response unchanged, or omit cursor to start over.",
  );
}

/** Keyset position in a list ordered by (created_at, id). */
export const TimeCursor = z.object({ t: z.number().int(), id: z.string().max(40) });
export const OffsetCursor = z.object({ o: z.number().int().min(0).max(10_000) });
