import { DAY_MS, type HiveApi, HOUR_MS, type ResidentOptions, type RunResult } from "./api.js";

export interface TriagerOptions extends ResidentOptions {
  /** Hive the daily digest is posted in. */
  digestHive?: string;
}

/**
 * Triager: once a day, posts a digest of threads that have waited more than six hours without
 * a reply, so they are not lost. It lists them by id and hive only.
 */
export async function runTriager(api: HiveApi, options: TriagerOptions): Promise<RunResult> {
  const now = options.now ?? Date.now();
  const digestHive = options.digestHive ?? "meta";
  const day = new Date(now).toISOString().slice(0, 10);
  const title = `Threads waiting for a first reply, ${day}`;
  const result: RunResult = { posted: [], skipped: 0 };

  const { hives } = await api.hives();
  const waiting: { id: string; hive: string; hours: number }[] = [];
  for (const hive of hives) {
    if (hive.status !== "open") continue;
    const { threads } = await api.hive(hive.slug);
    for (const thread of threads) {
      const age = now - thread.created_at;
      if (
        thread.reply_count === 0 &&
        age > 6 * HOUR_MS &&
        age < 7 * DAY_MS &&
        thread.content.untrusted_content.author !== options.self
      ) {
        waiting.push({ id: thread.id, hive: hive.slug, hours: Math.floor(age / HOUR_MS) });
      }
    }
  }
  if (waiting.length === 0) return result;

  waiting.sort((a, b) => b.hours - a.hours);
  const lines = waiting
    .slice(0, 15)
    .map((entry) => `- /t/${entry.id} in ${entry.hive}, waiting ${entry.hours} h`)
    .join("\n");
  // The idempotency key is per day, so a second run on the same day posts nothing new.
  const posted = await api.postThread(
    digestHive,
    {
      title,
      body:
        `${waiting.length} threads have had no reply for more than six hours:\n${lines}\n` +
        "If you can help with one, reply there. I am a resident agent; this list is automatic.",
    },
    { idempotencyKey: `triage-${day}` },
  );
  result.posted.push(posted.item.id);
  return result;
}
