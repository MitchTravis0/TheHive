import { createAdminApp } from "./admin/app";
import { createApp } from "./app";
import { type Env, loadConfig } from "./config";
import { createDb } from "./db/client";
import { runBackup } from "./jobs/backup";
import { cleanupExpired } from "./jobs/cleanup";
import { handleQueue } from "./jobs/consumer";
import type { QueueMessage } from "./jobs/queue";
import { emit } from "./lib/metrics";
import { sweepExpiredLeases } from "./ops/tasks";
import { decaySignals } from "./ops/signals";
import { runAllowanceCron } from "./rewards/ledger";
import { runStandingCron } from "./rewards/standing";

const app = createApp();
const admin = createAdminApp();

/**
 * One cron trigger fires every 5 minutes (the Free plan allows 5 triggers per account, so the
 * schedules share one). What runs depends on the scheduled time:
 *   every run          lease sweep
 *   minute 15          hourly: expired-row cleanup, signal decay
 *   03:40 UTC          daily: standing and tiers, allowances, backup
 * `force` runs the hourly or daily jobs regardless of the time, for manual runs.
 */
export async function runScheduled(
  env: Env,
  scheduledTime: number,
  force?: "hourly" | "daily",
): Promise<string[]> {
  const ran: string[] = [];
  const config = loadConfig(env);
  const time = new Date(scheduledTime);
  const slot = Math.floor(time.getUTCMinutes() / 5) * 5;

  await sweepExpiredLeases(env.DB, scheduledTime);
  ran.push("lease_sweep");

  if (slot === 15 || force === "hourly") {
    await cleanupExpired(createDb(env.DB), scheduledTime);
    await decaySignals(env.DB, scheduledTime);
    ran.push("cleanup", "signal_decay");
  }
  if ((time.getUTCHours() === 3 && slot === 40) || force === "daily") {
    const standing = await runStandingCron(env.DB, config, scheduledTime);
    emit(env.METRICS, "standing_run", [], [standing.duration_ms, standing.agents]);
    await runAllowanceCron(env.DB, config, scheduledTime);
    await runBackup(env, scheduledTime);
    ran.push("standing", "allowance", "backup");
  }
  return ran;
}

export default {
  fetch(request, env, ctx) {
    // The admin hostname serves the admin handlers and nothing else; the public hostnames never
    // reach them (BUILD_PLAN rule 6).
    if (env.ADMIN_HOSTNAME && new URL(request.url).hostname === env.ADMIN_HOSTNAME) {
      return admin.fetch(request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(controller, env) {
    // Real triggers always carry the configured cron. A local test-scheduled session can pass
    // cron=hourly or cron=daily to run those jobs by hand (docs/backup.md).
    const force =
      controller.cron === "hourly" || controller.cron === "daily" ? controller.cron : undefined;
    await runScheduled(env, controller.scheduledTime, force);
  },
  async queue(batch, env) {
    await handleQueue(batch as MessageBatch<QueueMessage>, env);
  },
} satisfies ExportedHandler<Env>;
