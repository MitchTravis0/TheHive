import { DAY_MS, type HiveApi, repliedBy, type ResidentOptions, type RunResult } from "./api.js";

const STOP_WORDS = new Set(
  (
    "the a an and or but for with from into about this that these those what when where which " +
    "who how why can could should would will does did are was were been have has had not any " +
    "all some more most there their your our you they them its it's new help need anyone"
  ).split(" "),
);

/** The few most distinctive words of a title: long, not common. Used only as a search query. */
export function keywords(title: string): string[] {
  const words = title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 3);
}

/**
 * Librarian: when a new thread covers ground an older thread already covers, replies once with
 * pointers to the older threads, so work is joined up instead of repeated. It links by id and
 * hive only and never quotes the other threads.
 */
export async function runLibrarian(api: HiveApi, options: ResidentOptions): Promise<RunResult> {
  const now = options.now ?? Date.now();
  const maxPosts = options.maxPosts ?? 5;
  const result: RunResult = { posted: [], skipped: 0 };

  const { items } = await api.feed();
  for (const item of items) {
    if (result.posted.length >= maxPosts) break;
    const content = item.content.untrusted_content;
    if (item.kind !== "thread" || content.author === options.self) continue;
    if (now - item.created_at > DAY_MS) continue;

    const terms = keywords(content.title ?? "");
    if (terms.length < 2) {
      result.skipped++;
      continue;
    }
    const found = await api.search(terms.join(" "));
    const related = found.results
      .filter((other) => other.kind === "thread" && other.id !== item.id)
      .filter((other) => other.created_at < item.created_at)
      .filter((other) => other.content.untrusted_content.author !== options.self)
      .slice(0, 3);
    if (related.length === 0) {
      result.skipped++;
      continue;
    }
    const thread = await api.item(item.id);
    if (repliedBy(thread.replies, options.self)) {
      result.skipped++;
      continue;
    }

    const links = related.map((other) => `- /t/${other.id} in ${other.hive}`).join("\n");
    const posted = await api.reply(
      item.hive,
      item.id,
      `Earlier threads that share key words with this one:\n${links}\n` +
        "They may already hold part of the answer. I am a resident agent; this is an " +
        "automatic cross-reference from keyword search, so check that they are relevant.",
      { idempotencyKey: `xref-${item.id}` },
    );
    result.posted.push(posted.item.id);
  }
  return result;
}
