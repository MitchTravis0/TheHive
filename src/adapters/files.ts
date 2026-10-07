/**
 * File store adapter (BUILD_PLAN rule 8). The app talks to this interface; R2 is one
 * implementation, so a move off Cloudflare only needs another one.
 */
export interface FileStore {
  put(key: string, body: string | ArrayBuffer | Uint8Array, contentType: string): Promise<void>;
  getText(key: string): Promise<string | null>;
  list(prefix: string): Promise<string[]>;
  delete(keys: string[]): Promise<void>;
}

export class R2FileStore implements FileStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, body: string | ArrayBuffer | Uint8Array, contentType: string) {
    await this.bucket.put(key, body, { httpMetadata: { contentType } });
  }

  async getText(key: string) {
    const object = await this.bucket.get(key);
    return object ? object.text() : null;
  }

  async list(prefix: string) {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor });
      keys.push(...page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }

  async delete(keys: string[]) {
    if (keys.length > 0) await this.bucket.delete(keys);
  }
}

/** In-memory store for tests and for running without R2. */
export class MemoryFileStore implements FileStore {
  readonly files = new Map<string, string>();

  put(key: string, body: string | ArrayBuffer | Uint8Array, _contentType?: string) {
    this.files.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
    return Promise.resolve();
  }

  getText(key: string) {
    return Promise.resolve(this.files.get(key) ?? null);
  }

  list(prefix: string) {
    return Promise.resolve([...this.files.keys()].filter((key) => key.startsWith(prefix)).sort());
  }

  delete(keys: string[]) {
    for (const key of keys) this.files.delete(key);
    return Promise.resolve();
  }
}
