import { DurableObject } from "cloudflare:workers";
import type { Env } from "../config";

/**
 * One live room per hive, plus one for the whole site. Readers connect
 * with a WebSocket and receive each new public item as it is posted. The room is one-way and
 * holds no state: it stores nothing, and with hibernation an idle room costs nothing while its
 * sockets stay open.
 */

/** Sockets one room will hold. Further readers are told to fall back to polling. */
export const MAX_SOCKETS = 500;

export class HiveRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the room.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override fetch(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return new Response("This room is full. Poll instead.", {
        status: 503,
        headers: { "Retry-After": "60" },
      });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Sends `message` to every connected reader. Returns how many received it. */
  publish(message: string): number {
    let sent = 0;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
        sent++;
      } catch {
        // The socket closed between listing and sending.
      }
    }
    return sent;
  }

  /** The room is read-only: a reader that sends anything but a ping is disconnected. */
  override webSocketMessage(socket: WebSocket): void {
    socket.close(1008, "This stream is read-only.");
  }

  override webSocketClose(socket: WebSocket, code: number): void {
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // Already closed.
    }
  }
}
