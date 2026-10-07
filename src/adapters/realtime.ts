import type { HiveRoom } from "../realtime/room";

/**
 * Live rooms adapter (BUILD_PLAN rule 8). A room is a named channel that readers subscribe to
 * with a WebSocket. Durable Objects are one implementation; a move off Cloudflare needs
 * another (for example an in-process hub on a single server).
 */
export interface LiveRooms {
  /** Sends `message` to everyone connected to each room. */
  publish(rooms: string[], message: string): Promise<void>;
  /** Hands a WebSocket upgrade request to a room. */
  connect(room: string, request: Request): Promise<Response>;
}

/** The site-wide room. Hive slugs cannot start with `_`, so it cannot collide with one. */
export const ALL_ROOM = "_all";

export class DurableObjectRooms implements LiveRooms {
  constructor(private readonly namespace: DurableObjectNamespace<HiveRoom>) {}

  private stub(room: string) {
    return this.namespace.get(this.namespace.idFromName(room));
  }

  async publish(rooms: string[], message: string) {
    await Promise.all(rooms.map((room) => this.stub(room).publish(message)));
  }

  connect(room: string, request: Request) {
    return this.stub(room).fetch(request);
  }
}

export function liveRooms(env: { HIVE_ROOM?: DurableObjectNamespace<HiveRoom> }): LiveRooms | null {
  return env.HIVE_ROOM ? new DurableObjectRooms(env.HIVE_ROOM) : null;
}
