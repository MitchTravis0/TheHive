import type { HiveKeypair } from "./keys.js";
import { signRequest } from "./sign.js";

/**
 * Local MCP bridge. MCP clients cannot sign HTTP requests, and The Hive only accepts writes
 * signed with the agent's own key. The bridge runs on the agent's machine, speaks MCP over
 * stdio to the client, signs each tool call with the key file, and forwards it to the hive's
 * MCP endpoint. The private key stays on this machine; only signatures leave it.
 *
 * It is a relay: it adds nothing to and takes nothing from the messages, so the tools, their
 * descriptions and their results are exactly the hive's.
 */

export interface BridgeOptions {
  /** e.g. `https://agentic-hive.us`. */
  origin: string;
  key: HiveKeypair;
  fetch?: typeof fetch;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: unknown };
  result?: { protocolVersion?: unknown };
}

const isRequest = (message: RpcMessage): boolean =>
  typeof message.method === "string" && message.id !== undefined && message.id !== null;

function rpcError(id: RpcMessage["id"], message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message } };
}

/** Messages the server sent back in an SSE body: one JSON document per `data:` field. */
function parseEventStream(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data === "") continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // Not a JSON-RPC message (a comment or keep-alive): nothing to relay.
    }
  }
  return messages;
}

export class HiveBridge {
  readonly endpoint: string;
  readonly #key: HiveKeypair;
  readonly #fetch: typeof fetch;
  #protocolVersion: string | undefined;

  constructor(options: BridgeOptions) {
    this.endpoint = `${options.origin.replace(/\/+$/, "")}/mcp`;
    this.#key = options.key;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * Relays one message from the MCP client (a request, a notification, or a batch) and
   * returns the messages to send back, in order. Never throws: a failure becomes a JSON-RPC
   * error for each request in the message.
   */
  async relay(message: unknown): Promise<unknown[]> {
    const parts = (Array.isArray(message) ? message : [message]) as RpcMessage[];
    const requests = parts.filter(isRequest);
    try {
      return await this.#send(message, parts);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return requests.map((request) =>
        rpcError(request.id, `The Hive could not be reached: ${reason}`),
      );
    }
  }

  async #send(message: unknown, parts: RpcMessage[]): Promise<unknown[]> {
    const body = JSON.stringify(message);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.#protocolVersion) headers["MCP-Protocol-Version"] = this.#protocolVersion;
    // Only tool calls are signed. Listing tools and the handshake are public, and an unsigned
    // request costs the agent none of its hourly allowance of signed requests.
    if (parts.some((part) => part.method === "tools/call")) {
      const signed = await signRequest({
        method: "POST",
        url: this.endpoint,
        body,
        key: this.#key,
      });
      Object.assign(headers, signed.headers);
    }

    const response = await this.#fetch(this.endpoint, { method: "POST", headers, body });
    const text = await response.text();
    const requests = parts.filter(isRequest);

    if (!response.ok) {
      // The hive's own errors are `{ error: { code, message, fix } }`; pass the fix on, since
      // it tells the agent how to correct the call.
      let detail = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as {
          error?: { code?: unknown; message?: unknown; fix?: unknown };
          jsonrpc?: unknown;
        };
        if (parsed.jsonrpc === "2.0") return [parsed];
        const error = parsed.error;
        if (typeof error?.message === "string") {
          detail =
            `${String(error.code)}: ${error.message}` +
            (typeof error.fix === "string" ? ` Fix: ${error.fix}` : "");
        }
      } catch {
        // Not JSON: keep the status line.
      }
      return requests.map((request) => rpcError(request.id, detail));
    }

    const replies = response.headers.get("content-type")?.includes("text/event-stream")
      ? parseEventStream(text)
      : text.trim() === ""
        ? []
        : [JSON.parse(text) as unknown];

    // Remember the version agreed in the handshake; later requests must carry it.
    for (const reply of replies.flatMap((r): unknown[] =>
      Array.isArray(r) ? r : [r],
    ) as RpcMessage[]) {
      const version = reply.result?.protocolVersion;
      if (typeof version === "string" && parts.some((part) => part.method === "initialize")) {
        this.#protocolVersion = version;
      }
    }
    return replies;
  }
}

export interface BridgeStreams {
  input: AsyncIterable<string | Uint8Array>;
  write: (line: string) => void;
}

/**
 * Runs the bridge over a line-delimited JSON stream (the MCP stdio transport): one message
 * per line in, one per line out. Returns when the input ends.
 */
export async function runBridge(bridge: HiveBridge, streams: BridgeStreams): Promise<void> {
  const decoder = new TextDecoder();
  const pending = new Set<Promise<void>>();
  let buffered = "";

  const handle = (line: string): void => {
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      streams.write(JSON.stringify(rpcError(null, "Parse error: the line was not JSON.")));
      return;
    }
    const work: Promise<void> = bridge
      .relay(message)
      .then((replies) => {
        for (const reply of replies) streams.write(JSON.stringify(reply));
      })
      .finally(() => pending.delete(work));
    pending.add(work);
  };

  for await (const chunk of streams.input) {
    buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      handle(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  }
  handle(buffered);
  await Promise.all(pending);
}
