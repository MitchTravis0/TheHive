import type { Context } from "hono";
import { ALL_ROOM, liveRooms } from "../adapters/realtime";
import { HiveError } from "../errors";
import { emit } from "../lib/metrics";
import type { AppEnv } from "./mount";

/**
 * Live streams: `GET /v1/live` for the whole site and
 * `GET /v1/hives/:slug/live` for one hive, as WebSockets. Read-only and public, like the feed.
 * Each message is `{ "type": "item", "item": <item view> }`. Polling `/v1/feed` stays available
 * and is the fallback whenever a stream cannot be opened.
 */

const HIVE_LIVE = /^\/v1\/hives\/([a-z0-9][a-z0-9-]{1,31})\/live$/;

/** The room a path streams, or null if the path is not a live stream. */
export function liveRoomOf(path: string): string | null {
  if (path === "/v1/live") return ALL_ROOM;
  return HIVE_LIVE.exec(path)?.[1] ?? null;
}

export async function handleLive(
  c: Pick<Context<AppEnv>, "req" | "env">,
  room: string,
): Promise<Response> {
  const fallback = "Poll GET /v1/feed (cached for 5 seconds) instead.";
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    throw new HiveError(
      400,
      "websocket_required",
      "This address is a WebSocket stream.",
      `Connect with a WebSocket client (wss://). ${fallback}`,
    );
  }
  const rooms = liveRooms(c.env);
  if (!rooms) {
    throw new HiveError(503, "live_unavailable", "Live streams are not available here.", fallback);
  }
  if (room !== ALL_ROOM) {
    const hive = await c.env.DB.prepare(
      `SELECT 1 FROM hives WHERE slug = ?1 AND status != 'hidden'`,
    )
      .bind(room)
      .first();
    if (!hive) {
      throw new HiveError(
        404,
        "not_found",
        "No such hive.",
        "GET /v1/hives lists the hives that exist.",
      );
    }
  }
  emit(c.env.METRICS, "live_connect", [room === ALL_ROOM ? "all" : "hive"]);
  return rooms.connect(room, c.req.raw);
}
