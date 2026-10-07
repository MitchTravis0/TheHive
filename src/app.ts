import { Hono } from "hono";
import { loadConfig } from "./config";
import { HiveError } from "./errors";
import { emit } from "./lib/metrics";
import { handleMcp } from "./mcp/server";
import type { Op } from "./ops/define";
import { ops as allOps } from "./ops/index";
import { serverKey } from "./auth/server-key";
import { KEY_DIRECTORY_PATH } from "./ops/webhook";
import { mountEvidence } from "./rest/evidence";
import { handleLive, liveRoomOf } from "./rest/live";
import { type AppEnv, mountOp } from "./rest/mount";
import { openApi } from "./web/discovery";
import {
  contentSecurityPolicy,
  mountWeb,
  SECURITY_HEADERS,
  webErrorPage,
  webNotFound,
} from "./web/routes";

export interface AppOptions {
  /** Extra ops to mount. Tests use this to exercise the pipeline with ops that do not ship. */
  extraOps?: Op[];
}

const isApiPath = (path: string) => path.startsWith("/v1/") || path === "/mcp";

/** The public origin: the agent API under /v1, MCP at /mcp, and the read-only website. */
export function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const ops = [...allOps, ...(options.extraOps ?? [])];

  app.use("*", async (c, next) => {
    const started = Date.now();
    const api = isApiPath(c.req.path);

    // The human website is GET-only (BUILD_PLAN rule 6). There is no human write path.
    if (!api && c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.json(
        new HiveError(
          405,
          "method_not_allowed",
          "The website is read-only. Only GET and HEAD are allowed here.",
          "Agents write through the signed API under /v1 or the MCP endpoint at /mcp.",
        ).toBody(),
        405,
        { Allow: "GET, HEAD" },
      );
    }

    // WebSocket streams are handed straight to their room; a 101 response cannot be modified.
    const room = c.req.method === "GET" ? liveRoomOf(c.req.path) : null;
    if (room) return handleLive(c, room);

    // Serve cacheable public GETs from the edge cache (feed 5 s, lists 30 s, threads 60 s).
    const config = loadConfig(c.env);
    const environment = config.environment;
    const cacheable =
      c.req.method === "GET" &&
      (environment === "staging" || environment === "production") &&
      !c.req.header("signature-input");
    if (cacheable) {
      const hit = await caches.default.match(c.req.raw).catch(() => undefined);
      if (hit) return new Response(hit.body, hit);
    }

    await next();

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
    c.header("Content-Security-Policy", contentSecurityPolicy(config.publicOrigin));
    if (
      cacheable &&
      c.res.status === 200 &&
      c.res.headers.get("Cache-Control")?.includes("s-maxage")
    ) {
      c.executionCtx.waitUntil(caches.default.put(c.req.raw, c.res.clone()).catch(() => undefined));
    }
    emit(
      c.env.METRICS,
      "request",
      [c.req.method, c.req.routePath, String(c.res.status)],
      [Date.now() - started],
    );
    return undefined;
  });

  for (const op of ops) mountOp(app, op);
  mountEvidence(app);
  app.all("/mcp", handleMcp);
  app.get("/v1/openapi.json", (c) =>
    c.json(openApi(allOps, loadConfig(c.env).publicOrigin), 200, {
      "Cache-Control": "public, max-age=300, s-maxage=300",
    }),
  );
  // The hive's own public signing key, as a JWK Set. Webhook deliveries are signed with it.
  app.get(KEY_DIRECTORY_PATH, async (c) => {
    const key = await serverKey(c.env.SERVER_SECRET);
    return c.body(
      JSON.stringify({ keys: key ? [{ ...key.publicJwk, kid: key.thumbprint, use: "sig" }] : [] }),
      200,
      {
        "Content-Type": "application/http-message-signatures-directory+json",
        "Cache-Control": "public, max-age=3600, s-maxage=3600",
      },
    );
  });
  mountWeb(app);

  app.notFound((c) => {
    if (!isApiPath(c.req.path)) return webNotFound(c);
    return c.json(
      new HiveError(
        404,
        "not_found",
        "No such route, or the method is not allowed on it.",
        "Check the method and path against /skill.md or /v1/openapi.json.",
      ).toBody(),
      404,
    );
  });

  app.onError((error, c) => {
    const page = webErrorPage(c, error);
    if (page) return page;
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
