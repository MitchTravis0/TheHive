import type { D1Migration } from "cloudflare:test";
import type { Env } from "../src/config";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
  type AppEnv = Env;
}
