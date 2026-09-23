import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type ImageEmbeddingProvider,
} from "../src/lib/retrieval/providers";

interface AssetRow {
  id: string;
  media_url: string;
}

interface Cache {
  model: string;
  assets: Record<string, { mediaUrl: string; vector: number[] }>;
}

const toVector = (values: number[]) => `[${values.join(",")}]`;
const normalize = (values: number[]) => {
  const magnitude = Math.sqrt(
    values.reduce((sum, component) => sum + component * component, 0),
  );
  return magnitude === 0 ? values : values.map((value) => value / magnitude);
};

async function embedWithFailureIsolation(
  rows: AssetRow[],
  provider: EmbeddingProvider & ImageEmbeddingProvider,
): Promise<Array<{ row: AssetRow; vector: number[] }>> {
  try {
    const vectors = await provider.embedImages(
      rows.map(({ media_url }) => media_url),
    );
    if (vectors.length !== rows.length) {
      throw new Error(
        `Jina returned ${vectors.length} vectors for ${rows.length} images.`,
      );
    }
    return rows.map((row, index) => ({ row, vector: vectors[index] }));
  } catch (error) {
    if (rows.length === 1) {
      console.warn(
        `[Jina reindex] skipped ${rows[0].id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
    const middle = Math.ceil(rows.length / 2);
    const [left, right] = await Promise.all([
      embedWithFailureIsolation(rows.slice(0, middle), provider),
      embedWithFailureIsolation(rows.slice(middle), provider),
    ]);
    return [...left, ...right];
  }
}

async function main() {
  const hosted = process.env.EMBEDDING_PROVIDER === "jina-api";
  if (!hosted) {
    process.env.IMAGE_EMBEDDING_MODEL = "jinaai/jina-clip-v2";
  }
  const imageColumn = hosted
    ? "jina_hosted_image_embedding"
    : "jina_image_embedding";
  const provider = createEmbeddingProvider();
  if (!("embedImages" in provider)) {
    throw new Error("The configured provider cannot embed images.");
  }
  const imageProvider = provider as EmbeddingProvider & ImageEmbeddingProvider;
  if (imageProvider.imageDimensions !== 256) {
    throw new Error(
      `The Jina index requires 256 dimensions, got ${imageProvider.imageDimensions}.`,
    );
  }

  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "******localhost:5432/art_explorer",
  });
  const batchSize = Math.max(
    1,
    Number(process.env.EMBEDDING_BATCH_SIZE ?? (hosted ? 16 : 4)),
  );
  const limit = Math.max(0, Number(process.env.REINDEX_LIMIT ?? 0));
  const cachePath = path.resolve(
    process.env.JINA_PILOT_CACHE ??
      ".cache/image-model-eval/jina-clip-v2-q4.json",
  );

  try {
    const allRows = (
      await pool.query<AssetRow>(
        `SELECT asset.id, asset.media_url
           FROM media_assets asset
           JOIN media_embeddings embedding ON embedding.asset_id = asset.id
          WHERE embedding.${imageColumn} IS NULL
            AND asset.media_url ~ '^(https?:|data:)'
          ORDER BY asset.id`,
      )
    ).rows;

    let cache: Cache | null = null;
    try {
      cache = JSON.parse(await readFile(cachePath, "utf8")) as Cache;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    let seeded = 0;
    if (!hosted && cache?.model === "jinaai/jina-clip-v2:q4") {
      for (const row of allRows) {
        const cached = cache.assets[row.id];
        if (
          cached?.mediaUrl === row.media_url &&
          cached.vector.length >= 256
        ) {
          const vector = normalize(cached.vector.slice(0, 256));
          await pool.query(
            `UPDATE media_embeddings
                SET ${imageColumn} = $2::vector, embedded_at = now()
              WHERE asset_id = $1`,
            [row.id, toVector(vector)],
          );
          seeded += 1;
        }
      }
    }
    if (seeded) {
      console.log(`[Jina reindex] restored ${seeded} vectors from cache`);
    }

    const pending = (
      await pool.query<AssetRow>(
        `SELECT asset.id, asset.media_url
           FROM media_assets asset
           JOIN media_embeddings embedding ON embedding.asset_id = asset.id
          WHERE embedding.${imageColumn} IS NULL
            AND asset.media_url ~ '^(https?:|data:)'
          ORDER BY asset.id`,
      )
    ).rows.slice(0, limit || undefined);
    const startedAt = Date.now();
    console.log(`[Jina reindex] ${pending.length} images remaining`);

    for (let start = 0; start < pending.length; start += batchSize) {
      const embedded = await embedWithFailureIsolation(
        pending.slice(start, start + batchSize),
        imageProvider,
      );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const { row, vector } of embedded) {
          await client.query(
            `UPDATE media_embeddings
                SET model_name = $3,
                    ${imageColumn} = $2::vector,
                    embedded_at = now()
              WHERE asset_id = $1`,
            [row.id, toVector(vector), provider.name],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const completed = Math.min(start + batchSize, pending.length);
      const rate = completed / Math.max(0.001, (Date.now() - startedAt) / 1000);
      console.log(
        `[Jina reindex] ${completed}/${pending.length} processed (${rate.toFixed(2)} images/s)`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
