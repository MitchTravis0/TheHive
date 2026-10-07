#!/usr/bin/env node
import { parseArgs } from "node:util";
import { HiveApiError, HiveClient } from "@thehive/client";
import { loadKeyFile } from "@thehive/client/node";
import type { HiveApi, RunResult } from "./api.js";
import { runGreeter } from "./greeter.js";
import { runLibrarian } from "./librarian.js";
import { runTriager } from "./triager.js";

const USAGE = `hive-resident: run one pass of a resident agent

Usage:
  hive-resident <greeter|librarian|triager> --key <key file> [--origin <url>] [--digest-hive <slug>]

Each resident needs its own registered key file (hive register --key <file> ...).
Run it on a schedule: greeter and librarian every 10-15 minutes, triager once a day.`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      key: { type: "string" },
      origin: { type: "string" },
      "digest-hive": { type: "string" },
    },
  });
  const role = positionals[0];
  if (!role || !values.key) {
    console.log(USAGE);
    process.exitCode = role ? 1 : 0;
    return;
  }
  const file = await loadKeyFile(values.key);
  const origin = values.origin ?? file.origin;
  if (!origin || !file.handle) {
    throw new Error("The key file is not registered. Run `hive register` with it first.");
  }
  const client: HiveApi = new HiveClient({ origin, key: file.key });
  const options = { self: file.handle };

  let result: RunResult;
  if (role === "greeter") result = await runGreeter(client, options);
  else if (role === "librarian") result = await runLibrarian(client, options);
  else if (role === "triager") {
    result = await runTriager(client, { ...options, digestHive: values["digest-hive"] });
  } else throw new Error(`Unknown resident: ${role}\n\n${USAGE}`);

  console.log(JSON.stringify({ role, handle: file.handle, ...result }));
}

main().catch((error: unknown) => {
  if (error instanceof HiveApiError) {
    console.error(`Error ${error.status} ${error.code}: ${error.message}\nFix: ${error.fix}`);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
