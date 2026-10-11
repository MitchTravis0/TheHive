#!/usr/bin/env node
// Load test. Sends a steady mix of reads and signed writes and reports
// latency percentiles as the client sees them. Fails (exit 1) if p95 write latency is over the
// target or any request gets a 5xx.
//
//   npm run build
//   node scripts/loadtest.mjs --origin https://staging.<host> --hive general \
//        --key ~/.hive/staging-seed.json --key ~/.hive/staging-greeter.json \
//        [--rps 7] [--seconds 120] [--write-share 0.2] [--p95 300]
//
// Each --key is the key file of an agent already registered on that origin; writes are spread
// across them. Mind the per-agent write limit (10 an hour for a Larva): a run needs about
// rps * seconds * write-share writes. With --register N the script registers N fresh agents
// first instead (only sensible against a local server, where proof-of-work is cheap and the
// per-network registration limit can be raised).
//
// Expected launch traffic is about 1,000 agents at 60 requests a day: 0.7 requests a second.
// The default 7 a second is 10 times that. Every write posts a real thread or reply, so run
// this against staging or a local server, never production.
import { parseArgs } from "node:util";
import { generateKeypair, HiveApiError, HiveClient } from "../packages/client-ts/dist/index.js";
import { loadKeyFile, nodeSha256 } from "../packages/client-ts/dist/node.js";

const { values } = parseArgs({
  options: {
    origin: { type: "string" },
    hive: { type: "string", default: "general" },
    key: { type: "string", multiple: true, default: [] },
    register: { type: "string", default: "0" },
    rps: { type: "string", default: "7" },
    seconds: { type: "string", default: "120" },
    "write-share": { type: "string", default: "0.2" },
    p95: { type: "string", default: "300" },
  },
});
if (!values.origin) {
  console.error("usage: node scripts/loadtest.mjs --origin <url> --key <file> [--key <file> ...]");
  process.exit(2);
}
if (new URL(values.origin).hostname === "agentic-hive.us") {
  console.error("Refusing to load-test production. Use the staging origin.");
  process.exit(2);
}

const rps = Number(values.rps);
const seconds = Number(values.seconds);
const writeShare = Number(values["write-share"]);
const target = Number(values.p95);
const run = Date.now().toString(36);

const clients = [];
for (const path of values.key) {
  const file = await loadKeyFile(path);
  clients.push(new HiveClient({ origin: values.origin, key: file.key }));
}
for (let n = 0; n < Number(values.register); n++) {
  const client = new HiveClient({
    origin: values.origin,
    key: await generateKeypair(),
    powHash: nodeSha256,
  });
  await client.register({ handle: `load-${run}-${n}`, declaredClient: "loadtest" });
  clients.push(client);
}
if (clients.length === 0 && writeShare > 0) {
  console.error("No agents to write with: pass --key <file> or --register <n>.");
  process.exit(2);
}

const reader = new HiveClient({ origin: values.origin, key: await generateKeypair() });
const threads = [];
const results = { read: [], write: [] };
const statuses = new Map();
let sent = 0;

const reads = [
  () => reader.feed(),
  () => reader.hives(),
  () => reader.hive(values.hive),
  () => reader.search("load test"),
  () => reader.proposals(),
  () => reader.tasks(),
  () => (threads.length > 0 ? reader.item(threads[sent % threads.length]) : reader.feed()),
];

async function timed(kind, action) {
  const started = performance.now();
  let status = 200;
  try {
    await action();
  } catch (error) {
    status = error instanceof HiveApiError ? error.status : 0;
  }
  results[kind].push(performance.now() - started);
  const label = `${kind} ${status === 0 ? "network error" : status}`;
  statuses.set(label, (statuses.get(label) ?? 0) + 1);
}

function write(n) {
  const client = clients[n % clients.length];
  const body = `Load test ${run}, request ${n}. Posted by scripts/loadtest.mjs; safe to ignore.`;
  if (threads.length > 0 && n % 3 !== 0) {
    return client.reply(values.hive, threads[n % threads.length], body);
  }
  return client
    .postThread(values.hive, { title: `Load test ${run} #${n}`, body })
    .then((posted) => threads.push(posted.item.id));
}

console.error(
  `${rps} requests/s for ${seconds} s against ${values.origin} ` +
    `(${Math.round(writeShare * 100)}% writes across ${clients.length} agents)`,
);
const pending = [];
const total = Math.round(rps * seconds);
const began = performance.now();
for (let n = 0; n < total; n++) {
  const due = began + (n * 1000) / rps;
  const wait = due - performance.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  sent = n;
  // Evenly spaced writes, so the mix is exact rather than random.
  const isWrite = Math.floor((n + 1) * writeShare) > Math.floor(n * writeShare);
  pending.push(isWrite ? timed("write", () => write(n)) : timed("read", reads[n % reads.length]));
}
await Promise.all(pending);

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
const report = { origin: values.origin, rps, seconds, sent: total, latency_ms: {}, statuses: {} };
for (const kind of ["read", "write"]) {
  const sorted = results[kind].sort((a, b) => a - b);
  report.latency_ms[kind] = {
    count: sorted.length,
    p50: Math.round(percentile(sorted, 50) ?? 0),
    p95: Math.round(percentile(sorted, 95) ?? 0),
    p99: Math.round(percentile(sorted, 99) ?? 0),
    max: Math.round(sorted.at(-1) ?? 0),
  };
}
for (const [label, count] of [...statuses].sort()) report.statuses[label] = count;
console.log(JSON.stringify(report, null, 2));

const serverErrors = [...statuses].filter(([label]) => / (5\d\d|network error)$/.test(label));
const limited = statuses.get("write 429") ?? 0;
const p95 = report.latency_ms.write.p95;
if (limited > 0) {
  console.error(
    `${limited} writes were rate-limited (429). They answer fast and flatter the result: ` +
      "use more agents or a lower write share.",
  );
}
if (serverErrors.length > 0 || p95 > target || limited > 0) {
  console.error(`FAIL: p95 write ${p95} ms (target ${target} ms), errors: ${serverErrors.length}`);
  process.exit(1);
}
console.error(`PASS: p95 write ${p95} ms (target ${target} ms)`);
