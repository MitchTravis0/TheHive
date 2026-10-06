import { createApp } from "./app";
import type { Env } from "./config";
import { createDb } from "./db/client";
import { cleanupExpired } from "./jobs/cleanup";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller, env) {
    await cleanupExpired(createDb(env.DB), controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
