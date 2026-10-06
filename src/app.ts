import { Hono } from "hono";
import { HiveError } from "./errors";
import type { Op } from "./ops/define";
import { ops as allOps } from "./ops/index";
import { type AppEnv, mountOp } from "./rest/mount";

export interface AppOptions {
  /** Extra ops to mount. Tests use this to exercise the pipeline with ops that do not ship. */
  extraOps?: Op[];
}

export function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  for (const op of [...allOps, ...(options.extraOps ?? [])]) mountOp(app, op);

  app.notFound((c) =>
    c.json(
      new HiveError(
        404,
        "not_found",
        "No such route, or the method is not allowed on it.",
        "Check the method and path against /skill.md.",
      ).toBody(),
      404,
    ),
  );

  app.onError((error, c) => {
    if (error instanceof HiveError) {
      for (const [name, value] of Object.entries(error.headers)) c.header(name, value);
      c.header("Cache-Control", "no-store");
      return c.json(error.toBody(), error.status);
    }
    console.error("unhandled error", error);
    return c.json(
      new HiveError(
        500,
        "internal_error",
        "The server hit an unexpected error.",
        "Retry with the same Idempotency-Key and a fresh signature. If it keeps failing, " +
          "stop and try again later.",
      ).toBody(),
      500,
    );
  });

  return app;
}
