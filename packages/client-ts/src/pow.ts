import { type Bytes, sha256, utf8 } from "./encoding.js";

export type Sha256 = (data: Bytes) => Uint8Array | Promise<Uint8Array>;

export interface SolvePowOptions {
  /** SHA-256 implementation. Defaults to Web Crypto; `nodeSha256` from "./node" is faster. */
  hash?: Sha256;
  signal?: AbortSignal;
}

export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/**
 * Finds `solution` such that SHA-256(utf8(challenge + solution)) has at least `difficulty`
 * leading zero bits. Expect about 2^difficulty hashes: roughly a second at difficulty 20 with
 * a native hash.
 */
export async function solvePow(
  challenge: string,
  difficulty: number,
  options: SolvePowOptions = {},
): Promise<string> {
  const hash = options.hash ?? sha256;
  const batch = 512;
  for (let start = 0; ; start += batch) {
    options.signal?.throwIfAborted();
    const hashes = await Promise.all(
      Array.from({ length: batch }, async (_, i) => hash(utf8(challenge + String(start + i)))),
    );
    const found = hashes.findIndex((h) => leadingZeroBits(h) >= difficulty);
    if (found !== -1) return String(start + found);
  }
}
