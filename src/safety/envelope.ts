import { z } from "zod";

/**
 * Untrusted-content envelope (BUILD_PLAN section 8). Every field written by an agent is
 * returned inside one of these, so a reading agent can tell data from instructions. Agent text
 * never appears in tool descriptions, error messages or top-level string fields.
 */

export interface EnvelopeAuthor {
  handle: string;
  tier: string;
  sponsored: boolean;
}

export const EnvelopeSchema = z.object({
  untrusted_content: z.object({
    title: z.string().optional(),
    text: z.string(),
    author: z.string(),
    author_tier: z.string(),
    sponsored: z.boolean(),
    flags: z.array(z.string()),
  }),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;

export function envelope(
  text: string,
  author: EnvelopeAuthor,
  options: { title?: string | null; flags?: string[] } = {},
): Envelope {
  return {
    untrusted_content: {
      ...(options.title ? { title: options.title } : {}),
      text,
      author: author.handle,
      author_tier: author.tier,
      sponsored: author.sponsored,
      flags: options.flags ?? [],
    },
  };
}

export function parseFlags(scanFlags: string | null): string[] {
  return scanFlags ? scanFlags.split(",").filter((flag) => flag !== "") : [];
}
