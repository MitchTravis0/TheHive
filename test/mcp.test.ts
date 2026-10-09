import { describe, expect, it } from "vitest";
import { type HiveKeypair, signRequest } from "../packages/client-ts/src/index";
import {
  call,
  createHive,
  grantAllowance,
  ORIGIN,
  registerAgent,
  registerAs,
} from "./helpers/harness";

interface RpcResponse {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

let rpcId = 0;

/** Sends one JSON-RPC message to /mcp, signed if a key is given. */
async function rpc(method: string, params: unknown, key?: HiveKeypair): Promise<Response> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (key) {
    const signed = await signRequest({ method: "POST", url: `${ORIGIN}/mcp`, body, key });
    Object.assign(headers, signed.headers);
  }
  return call(new Request(`${ORIGIN}/mcp`, { method: "POST", headers, body }));
}

async function rpcResult(response: Response): Promise<RpcResponse> {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .at(-1);
    return JSON.parse(data ?? "{}") as RpcResponse;
  }
  return JSON.parse(text) as RpcResponse;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  key?: HiveKeypair,
): Promise<ToolResult> {
  const response = await rpc("tools/call", { name, arguments: args }, key);
  expect(response.status).toBe(200);
  const parsed = await rpcResult(response);
  expect(parsed.error).toBeUndefined();
  return parsed.result as unknown as ToolResult;
}

const payload = (result: ToolResult) =>
  JSON.parse(result.content[0]?.text ?? "{}") as Record<string, never>;

describe("MCP server", () => {
  it("initializes and lists the tools with static descriptions", async () => {
    const init = await rpcResult(
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      }),
    );
    expect(init.result?.serverInfo).toMatchObject({ name: "the-hive" });
    expect(String(init.result?.instructions)).toContain("untrusted_content");

    const list = await rpcResult(await rpc("tools/list", {}));
    const tools = list.result?.tools as { name: string; description: string }[];
    // The 12 tools of BUILD_PLAN section 8.
    expect(tools.map((t) => t.name).sort()).toEqual([
      "comb_confirm",
      "comb_write",
      "hive_post",
      "hive_pulse",
      "hive_read",
      "hive_search",
      "kudos_give",
      "proposal_vote",
      "task_claim",
      "task_list",
      "task_review",
      "task_submit",
    ]);
  });

  it("reads without a signature and wraps agent content in envelopes", async () => {
    const { slug, seed } = await createHive();
    const posted = await seed.client.postThread(slug, { title: "Over MCP", body: "Readable." });

    const hive = payload(await callTool("hive_read", { target: "hive", id: slug }));
    expect(hive).toMatchObject({ hive: { slug }, threads: [{ id: posted.item.id }] });
    const item = await callTool("hive_read", { target: "item", id: posted.item.id });
    expect(item.structuredContent).toMatchObject({
      item: { content: { untrusted_content: { text: "Readable.", author: seed.agent.handle } } },
    });
    expect(payload(await callTool("hive_read", { target: "hives" }))).toHaveProperty("hives");
    expect(payload(await callTool("hive_read", { target: "feed" }))).toHaveProperty("stats");
    const found = payload(await callTool("hive_search", { q: "Readable" }));
    expect(found).toHaveProperty("results");
  });

  it("returns teaching errors as tool errors", async () => {
    const missing = await callTool("hive_read", { target: "item", id: "01NOPE" });
    expect(missing.isError).toBe(true);
    expect(payload(missing)).toMatchObject({ error: { code: "not_found" } });
  });

  it("refuses to post or pulse without a signature", async () => {
    const { slug } = await createHive();
    const post = await callTool("hive_post", {
      hive: slug,
      kind: "thread",
      title: "Unsigned",
      body: "Should not be stored.",
      idempotency_key: crypto.randomUUID(),
    });
    expect(post.isError).toBe(true);
    expect(payload(post)).toMatchObject({ error: { code: "signature_missing" } });
    const pulse = await callTool("hive_pulse", {});
    expect(payload(pulse)).toMatchObject({ error: { code: "signature_missing" } });
  });

  it("posts with a signed request, idempotently, and pulses", async () => {
    const { slug } = await createHive();
    const { key, agent } = await registerAgent();
    const args = {
      hive: slug,
      kind: "thread",
      title: "Posted over MCP",
      body: "Signed tool call.",
      idempotency_key: crypto.randomUUID(),
    };
    const first = payload(await callTool("hive_post", args, key));
    const retry = payload(await callTool("hive_post", args, key));
    expect(first).toMatchObject({ item: { hive: slug, kind: "thread" } });
    expect(retry).toEqual(first);

    const reuse = await callTool("hive_post", { ...args, body: "Different body." }, key);
    expect(payload(reuse)).toMatchObject({ error: { code: "idempotency_key_reused" } });

    const pulse = payload(await callTool("hive_pulse", {}, key));
    expect(pulse).toMatchObject({ agent: { handle: agent.handle } });
  });

  it("runs a whole task, comb and kudos flow through tools", async () => {
    const { slug } = await createHive();
    const poster = await registerAgent();
    const worker = await registerAgent();
    const verifier = await registerAs({ tier: "worker", status: "active" });
    await grantAllowance(verifier.agent.id, 10);
    const k = () => crypto.randomUUID();

    const created = payload(
      await callTool(
        "hive_post",
        {
          kind: "task",
          hive: slug,
          title: "Tool task",
          body: "Do the thing over MCP.",
          skills: ["mcp"],
          idempotency_key: k(),
        },
        poster.key,
      ),
    ) as unknown as { task: { id: string } };
    const id = created.task.id;
    expect(payload(await callTool("task_list", { skills: ["mcp"], hive: slug }))).toMatchObject({
      tasks: [{ id }],
    });
    expect(
      payload(await callTool("task_claim", { id, idempotency_key: k() }, worker.key)),
    ).toMatchObject({
      task: { state: "claimed" },
    });
    expect(
      payload(
        await callTool(
          "task_submit",
          { id, submission: "Did the thing, see notes.", idempotency_key: k() },
          worker.key,
        ),
      ),
    ).toMatchObject({ task: { state: "submitted" } });
    expect(
      payload(
        await callTool(
          "task_review",
          { id, verdict: "verify", idempotency_key: k() },
          verifier.key,
        ),
      ),
    ).toMatchObject({ task: { state: "verified" } });
    expect(payload(await callTool("task_list", { id }))).toMatchObject({
      task: { state: "verified" },
    });

    const entry = payload(
      await callTool(
        "comb_write",
        {
          hive: slug,
          title: "Tool-written entry",
          body: "Knowledge recorded through the MCP tool.",
          idempotency_key: k(),
        },
        verifier.key,
      ),
    ) as unknown as { entry: { id: string } };
    expect(
      payload(
        await callTool(
          "comb_confirm",
          { id: entry.entry.id, stance: "confirm", idempotency_key: k() },
          worker.key,
        ),
      ),
    ).toMatchObject({ entry: { confirms: 1 } });
    expect(
      payload(await callTool("hive_read", { target: "comb", id: entry.entry.id })),
    ).toMatchObject({
      version: 1,
      confirms: 1,
    });
    expect(
      payload(
        await callTool(
          "kudos_give",
          { item_id: id, amount: 3, reason: "completed", idempotency_key: k() },
          verifier.key,
        ),
      ),
    ).toMatchObject({ wallet: { allowance_remaining: 7 } });
    expect(
      payload(
        await callTool(
          "hive_post",
          { kind: "signal", item_id: id, signal: "high_value", idempotency_key: k() },
          worker.key,
        ),
      ),
    ).toMatchObject({ signal: { live_count: 1 } });
    expect(
      payload(
        await callTool(
          "hive_post",
          {
            kind: "report",
            item_id: entry.entry.id,
            body: "Reporting this entry as a test.",
            idempotency_key: k(),
          },
          worker.key,
        ),
      ),
    ).toMatchObject({ report: { state: "open" } });

    // The poster's pulse shows the task changed state; the worker's wallet holds no bounty.
    const pulse = payload(await callTool("hive_pulse", {}, poster.key)) as unknown as {
      task_updates: { id: string; state: string; role: string }[];
      wallet: { balance: number };
    };
    expect(pulse.task_updates).toEqual([
      expect.objectContaining({ id, state: "verified", role: "posted" }),
    ]);
  });

  it("rejects a tampered or replayed signed request at the HTTP layer", async () => {
    const { key } = await registerAgent();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const signed = await signRequest({ method: "POST", url: `${ORIGIN}/mcp`, body, key });
    const headers = {
      ...signed.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const tampered = await call(
      new Request(`${ORIGIN}/mcp`, { method: "POST", headers, body: body.replace("list", "call") }),
    );
    expect(tampered.status).toBe(401);
    const ok = await call(new Request(`${ORIGIN}/mcp`, { method: "POST", headers, body }));
    expect(ok.status).toBe(200);
    const replay = await call(new Request(`${ORIGIN}/mcp`, { method: "POST", headers, body }));
    expect(replay.status).toBe(401);
  });

  it("enforces the write rate limit on tool calls", async () => {
    const { slug } = await createHive();
    const { key } = await registerAgent();
    const post = (n: number) =>
      callTool(
        "hive_post",
        {
          hive: slug,
          kind: "thread",
          title: `Thread ${n}`,
          body: `Body number ${n}.`,
          idempotency_key: crypto.randomUUID(),
        },
        key,
      );
    for (let n = 0; n < 10; n++) expect((await post(n)).isError).toBeUndefined();
    expect(payload(await post(10))).toMatchObject({ error: { code: "rate_limited" } });
  });
});

describe("local MCP bridge", () => {
  // The bridge is what `npx @agentic-hive/client mcp` runs: it signs tool calls with the
  // agent's key so an ordinary MCP client, which cannot sign requests, can write.
  const bridgeFor = async (key: HiveKeypair, fetcher?: typeof fetch) => {
    const { HiveBridge } = await import("../packages/client-ts/src/index");
    return new HiveBridge({
      origin: ORIGIN,
      key,
      fetch: fetcher ?? ((input, init) => call(new Request(input, init))),
    });
  };
  const toolCall = (id: number, name: string, args: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const firstResult = (replies: unknown[]) =>
    (replies[0] as { result: ToolResult; error?: unknown }).result;

  it("lets an MCP client post, reply and pulse through the agent's key", async () => {
    const { slug } = await createHive();
    const agent = await registerAgent();
    const bridge = await bridgeFor(agent.key);

    const [init] = (await bridge.relay({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "some-mcp-client", version: "1" },
      },
    })) as RpcResponse[];
    expect(init?.result?.serverInfo).toMatchObject({ name: "the-hive" });
    // A notification has no reply.
    expect(await bridge.relay({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual([]);
    const [list] = (await bridge.relay({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })) as RpcResponse[];
    expect((list?.result?.tools as unknown[]).length).toBe(12);

    const posted = payload(
      firstResult(
        await bridge.relay(
          toolCall(3, "hive_post", {
            kind: "thread",
            hive: slug,
            title: "Posted through the bridge",
            body: "An MCP client that cannot sign wrote this.",
            idempotency_key: crypto.randomUUID(),
          }),
        ),
      ),
    ) as unknown as { item: { id: string } };
    expect(posted.item.id).toBeTruthy();
    const stored = await agent.client.item(posted.item.id);
    expect(stored.item.content.untrusted_content.author).toBe(agent.agent.handle);

    const pulse = payload(firstResult(await bridge.relay(toolCall(4, "hive_pulse", {}))));
    expect(pulse).toMatchObject({ agent: { handle: agent.agent.handle } });
  });

  it("signs tool calls only, and turns failures into JSON-RPC errors with the fix", async () => {
    const agent = await registerAgent();
    const seen: { signed: boolean; version: string | null }[] = [];
    const recording: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ signed: headers.has("signature"), version: headers.get("mcp-protocol-version") });
      return call(new Request(input, init));
    };
    const bridge = await bridgeFor(agent.key, recording);
    await bridge.relay({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "c", version: "1" },
      },
    });
    await bridge.relay({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await bridge.relay(toolCall(3, "hive_read", { target: "hives" }));
    expect(seen.map((request) => request.signed)).toEqual([false, false, true]);
    // The version agreed in the handshake is sent on every later request.
    expect(seen[0]?.version).toBeNull();
    expect(seen[1]?.version).toBeTruthy();

    // A key the hive does not know: the hive's teaching error reaches the client.
    const { generateKeypair } = await import("../packages/client-ts/src/index");
    const stranger = await bridgeFor(await generateKeypair());
    const [refused] = (await stranger.relay(toolCall(9, "hive_pulse", {}))) as {
      id: number;
      error: { message: string };
    }[];
    expect(refused?.id).toBe(9);
    expect(refused?.error.message).toContain("key_unknown");
    expect(refused?.error.message).toContain("Fix:");

    // The network is down: an error, never a hang or a crash.
    const offline = await bridgeFor(agent.key, () => Promise.reject(new Error("offline")));
    const [down] = (await offline.relay(toolCall(10, "hive_pulse", {}))) as {
      error: { message: string };
    }[];
    expect(down?.error.message).toContain("could not be reached");
  });

  it("speaks line-delimited JSON over a stream", async () => {
    const { runBridge } = await import("../packages/client-ts/src/index");
    const agent = await registerAgent();
    const bridge = await bridgeFor(agent.key);
    const lines = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      "not json",
      JSON.stringify(toolCall(2, "hive_read", { target: "hives" })),
    ].join("\n");
    // Delivered in awkward chunks, as a pipe would.
    async function* chunks() {
      const bytes = new TextEncoder().encode(lines);
      for (let at = 0; at < bytes.length; at += 37) {
        yield bytes.slice(at, at + 37);
        await Promise.resolve();
      }
    }
    const out: { id: number | null; result?: unknown; error?: unknown }[] = [];
    await runBridge(bridge, {
      input: chunks(),
      write: (line) => out.push(JSON.parse(line) as (typeof out)[number]),
    });
    expect(out.map((message) => message.id).sort()).toEqual([1, 2, null].sort());
    expect(out.find((message) => message.id === null)?.error).toBeTruthy();
    expect(out.find((message) => message.id === 2)?.result).toBeTruthy();
  });
});
