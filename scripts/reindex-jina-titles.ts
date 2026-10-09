import { Pool } from "pg";
import { TransformersEmbeddingProvider } from "../src/lib/retrieval/providers";

interface AssetRow {
  id: string;
  title: string;
}

const toVector = (values: number[]) => `[${values.join(",")}]`;

async function main() {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "******localhost:5432/art_explorer",
  });
  const batchSize = Math.max(
    1,
    Number(process.env.EMBEDDING_BATCH_SIZE ?? 128),
  );
  const limit = Math.max(0, Number(process.env.REINDEX_LIMIT ?? 0));
  const provider = new TransformersEmbeddingProvider("jinaai/jina-clip-v2");

  try {
    await pool.query(
      `ALTER TABLE media_embeddings
         ADD COLUMN IF NOT EXISTS jina_title_embedding vector(256)`,
    );
    const pending = (
      await pool.query<AssetRow>(
        `SELECT asset.id, asset.title
           FROM media_assets asset
           JOIN media_embeddings embedding ON embedding.asset_id = asset.id
          WHERE embedding.jina_title_embedding IS NULL
            AND lower(trim(asset.title)) NOT IN ('', 'untitled')
          ORDER BY asset.id`,
      )
    ).rows.slice(0, limit || undefined);
    const startedAt = Date.now();
    console.log(`[Title reindex] ${pending.length} titles remaining`);

    for (let start = 0; start < pending.length; start += batchSize) {
      const batch = pending.slice(start, start + batchSize);
      const vectors = await provider.embedImageDocuments(
        batch.map(({ title }) => title),
      );
      if (vectors.length !== batch.length) {
        throw new Error(
          `Jina returned ${vectors.length} vectors for ${batch.length} titles.`,
        );
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const [index, row] of batch.entries()) {
          await client.query(
            `UPDATE media_embeddings
                SET jina_title_embedding = $2::vector,
                    embedded_at = now()
              WHERE asset_id = $1`,
            [row.id, toVector(vectors[index])],
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
        `[Title reindex] ${completed}/${pending.length} processed ` +
          `(${rate.toFixed(2)} titles/s)`,
      );
    }

    await pool.query(
      `CREATE INDEX IF NOT EXISTS media_embeddings_jina_title_hnsw_idx
         ON media_embeddings
      USING hnsw (jina_title_embedding vector_cosine_ops)`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
