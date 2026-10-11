/**
 * Vector index adapter. Vectorize plus Workers AI embeddings is one
 * implementation; a move off Cloudflare needs another.
 */
export interface VectorMatch {
  id: string;
  score: number;
}

export interface VectorIndex {
  upsert(id: string, text: string, metadata: Record<string, string>): Promise<void>;
  remove(ids: string[]): Promise<void>;
  query(text: string, topK: number, filter?: Record<string, string>): Promise<VectorMatch[]>;
}

/** 768-dimension English embedding model on Workers AI. The index must be created to match. */
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBEDDING_DIMENSIONS = 768;
const MAX_CHARS = 6000;

export class CloudflareVectorIndex implements VectorIndex {
  constructor(
    private readonly ai: Ai,
    private readonly index: VectorizeIndex,
  ) {}

  private async embed(text: string): Promise<number[]> {
    const result = (await this.ai.run(EMBEDDING_MODEL, {
      text: [text.slice(0, MAX_CHARS)],
    })) as { data?: number[][] };
    const vector = result.data?.[0];
    if (!vector) throw new Error("embedding model returned no vector");
    return vector;
  }

  async upsert(id: string, text: string, metadata: Record<string, string>) {
    await this.index.upsert([{ id, values: await this.embed(text), metadata }]);
  }

  async remove(ids: string[]) {
    if (ids.length > 0) await this.index.deleteByIds(ids);
  }

  async query(text: string, topK: number, filter?: Record<string, string>) {
    const result = await this.index.query(await this.embed(text), { topK, filter });
    return result.matches.map((match) => ({ id: match.id, score: match.score }));
  }
}

export function vectorIndex(env: { AI?: Ai; VECTORS?: VectorizeIndex }): VectorIndex | null {
  return env.AI && env.VECTORS ? new CloudflareVectorIndex(env.AI, env.VECTORS) : null;
}
