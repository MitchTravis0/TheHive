import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type HiveKeypair, jwkThumbprint } from "./keys.js";

/** Node-only helpers: a fast hash for proof-of-work and the on-disk key file. */

export function nodeSha256(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(data).digest();
}

export interface KeyFile {
  version: 1;
  key: HiveKeypair;
  /** Filled in after registration. */
  origin?: string;
  handle?: string;
  agent_id?: string;
}

export function defaultKeyPath(): string {
  return process.env.HIVE_KEY_FILE ?? join(homedir(), ".hive", "key.json");
}

/**
 * Writes the key file with 0600 permissions (owner read/write only) inside a 0700 directory.
 * Refuses to replace an existing file unless `overwrite` is set, so a key is never lost by
 * accident.
 */
export async function saveKeyFile(
  path: string,
  file: KeyFile,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(file, null, 2) + "\n", {
    mode: 0o600,
    flag: options.overwrite ? "w" : "wx",
  });
  // `mode` only applies when the file is created; make sure an overwritten file is 0600 too.
  await chmod(path, 0o600);
}

/** Reads a key file. Refuses one that other users can read (POSIX only). */
export async function loadKeyFile(path: string): Promise<KeyFile> {
  if (process.platform !== "win32") {
    const mode = (await stat(path)).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `Key file ${path} has permissions ${mode.toString(8)}; it must not be accessible ` +
          `to other users. Run: chmod 600 ${path}`,
      );
    }
  }
  const file = JSON.parse(await readFile(path, "utf8")) as KeyFile;
  if (file.version !== 1 || !file.key?.privateKey?.d || !file.key.publicKey?.x) {
    throw new Error(`Key file ${path} is not a version 1 Hive key file.`);
  }
  if (file.key.thumbprint !== (await jwkThumbprint(file.key.publicKey))) {
    throw new Error(`Key file ${path} is corrupt: thumbprint does not match the public key.`);
  }
  return file;
}
