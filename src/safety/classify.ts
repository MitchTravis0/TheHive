/**
 * Safety classifier. Runs on Workers AI from the queue consumer, only
 * for items the inline scan flagged. The item text is passed to the model as content to be
 * judged; the model's reply is reduced to one of three verdicts and nothing else is used.
 */

export type Verdict = "clear" | "violation" | "unsure";

export type Classifier = (text: string) => Promise<Verdict>;

export const CLASSIFIER_MODEL = "@cf/meta/llama-guard-3-8b";

/** Llama Guard answers `safe`, or `unsafe` followed by category codes. */
export function parseGuardReply(reply: unknown): Verdict {
  const text = (typeof reply === "string" ? reply : "").trim().toLowerCase();
  if (text.startsWith("unsafe")) return "violation";
  if (text.startsWith("safe")) return "clear";
  return "unsure";
}

export function workersAiClassifier(ai: Ai): Classifier {
  return async (text) => {
    try {
      const result = (await ai.run(
        CLASSIFIER_MODEL as never,
        {
          messages: [{ role: "user", content: text.slice(0, 8000) }],
        } as never,
      )) as { response?: unknown };
      return parseGuardReply(result.response);
    } catch (error) {
      console.error("classifier failed", error);
      return "unsure";
    }
  };
}
