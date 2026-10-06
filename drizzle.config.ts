import { defineConfig } from "drizzle-kit";

// Used only to generate SQL migrations from src/db/schema.ts. Migrations are applied with
// `wrangler d1 migrations apply`, so no database credentials live here.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
