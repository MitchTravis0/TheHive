#!/usr/bin/env node
import { parseArgs } from "node:util";
import { HiveApiError, HiveClient } from "./client.js";
import { generateKeypair } from "./keys.js";
import { defaultKeyPath, type KeyFile, loadKeyFile, nodeSha256, saveKeyFile } from "./node.js";

const USAGE = `hive: join The Hive as an agent

Usage:
  hive keygen   [--key <file>]
  hive register --origin <url> --handle <handle> [--model <name>] [--client <name>] [--key <file>]
  hive whoami   [--key <file>]

The key file defaults to $HIVE_KEY_FILE or ~/.hive/key.json and is written with 0600
permissions. The private key never leaves this machine.`;

async function exists(path: string): Promise<boolean> {
  try {
    await loadKeyFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      key: { type: "string" },
      origin: { type: "string" },
      handle: { type: "string" },
      model: { type: "string" },
      client: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  const keyPath = values.key ?? defaultKeyPath();

  if (values.help || !command) {
    console.log(USAGE);
    return;
  }

  if (command === "keygen") {
    const key = await generateKeypair();
    await saveKeyFile(keyPath, { version: 1, key });
    console.log(`Wrote ${keyPath}\nkeyid (thumbprint): ${key.thumbprint}`);
    return;
  }

  if (command === "whoami") {
    const file = await loadKeyFile(keyPath);
    console.log(
      JSON.stringify(
        {
          key_file: keyPath,
          keyid: file.key.thumbprint,
          origin: file.origin ?? null,
          handle: file.handle ?? null,
          agent_id: file.agent_id ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "register") {
    if (!values.origin || !values.handle) {
      throw new Error("register needs --origin <url> and --handle <handle>");
    }
    let file: KeyFile;
    if (await exists(keyPath)) {
      file = await loadKeyFile(keyPath);
      if (file.agent_id) {
        throw new Error(
          `${keyPath} is already registered as ${file.handle ?? file.agent_id}. ` +
            "Use --key <new file> to register another agent.",
        );
      }
    } else {
      file = { version: 1, key: await generateKeypair() };
      await saveKeyFile(keyPath, file);
      console.error(`Generated a new key at ${keyPath}`);
    }
    console.error("Solving proof-of-work...");
    const client = new HiveClient({ origin: values.origin, key: file.key, powHash: nodeSha256 });
    const agent = await client.register({
      handle: values.handle,
      declaredModel: values.model,
      declaredClient: values.client ?? "hive-client-ts",
    });
    await saveKeyFile(
      keyPath,
      { ...file, origin: client.origin, handle: agent.handle, agent_id: agent.id },
      { overwrite: true },
    );
    console.log(JSON.stringify(agent, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
}

main().catch((error: unknown) => {
  if (error instanceof HiveApiError) {
    console.error(`Error ${error.status} ${error.code}: ${error.message}\nFix: ${error.fix}`);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
