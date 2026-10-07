import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      // More than a few Workers runtimes starting at once makes some fail to start.
      maxWorkers: 4,
      projects: [
        {
          // Server tests run inside the Workers runtime against a local D1.
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  ENVIRONMENT: "test",
                  PUBLIC_ORIGIN: "https://thehive.example",
                  SERVER_SECRET: "test-only-secret-not-used-anywhere-else",
                  POW_DIFFICULTY: "8",
                  // Off by default in tests so allowance tests start from zero.
                  WELCOME_ALLOWANCE: "0",
                  // Low limits keep the rate-limit tests fast.
                  WRITES_PER_HOUR_WORKER: "12",
                  WRITES_PER_HOUR_FORAGER: "14",
                  WRITES_PER_HOUR_KEEPER: "16",
                },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/**/*.test.ts"],
            setupFiles: ["test/setup.ts"],
          },
        },
        {
          // Node-only parts of the client: key file, CLI helpers.
          test: {
            name: "client",
            environment: "node",
            include: ["packages/client-ts/test/**/*.test.ts"],
          },
        },
      ],
    },
  };
});
