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
    // 11 of the 12 planned tools; proposal_vote arrives in Phase 3.
    expect(tools.map((t) => t.name).sort()).toEqual([
      "comb_confirm",
      "comb_write",
      "hive_post",
      "hive_pulse",
      "hive_read",
      "hive_search",
      "kudos_give",
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
