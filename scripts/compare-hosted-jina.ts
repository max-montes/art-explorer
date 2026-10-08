import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import {
  HostedJinaEmbeddingProvider,
  TransformersEmbeddingProvider,
} from "../src/lib/retrieval/providers";
import { prepareHostedJinaImage } from "./hosted-jina-image";

type Judgment = "relevant" | "unsure" | "not_relevant";

interface Label {
  query: string;
  assetId: string;
  label: Judgment;
  rankingMethod?: string;
}

interface AssetRow {
  id: string;
  media_url: string;
  local_vector: string;
}

interface Cache {
  model: "jina-clip-v2";
  maxPixels: number;
  assets: Record<
    string,
    { mediaUrl: string; vector: number[] }
  >;
}

const parseVector = (value: string) =>
  value
    .slice(1, -1)
    .split(",")
    .map(Number);

const dot = (left: number[], right: number[]) =>
  left.reduce(
    (score, component, index) => score + component * right[index],
    0,
  );

const gain = (label: Judgment, lenient: boolean) =>
  label === "relevant" ? 1 : label === "unsure" && lenient ? 0.5 : 0;

const dcg = (grades: number[]) =>
  grades.reduce(
    (score, grade, index) => score + grade / Math.log2(index + 2),
    0,
  );

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const labelPaths = process.argv.slice(2);
  if (!labelPaths.length) {
    throw new Error("Pass the prior evaluator label exports.");
  }
  const judgments = new Map<string, Label>();
  for (const labelPath of labelPaths) {
    const parsed = JSON.parse(
      await readFile(path.resolve(labelPath), "utf8"),
    ) as { labels?: Label[] };
    for (const label of parsed.labels ?? []) {
      if (
        label.rankingMethod !== "image" &&
        !label.rankingMethod?.startsWith("blind:")
      ) {
        continue;
      }
      judgments.set(`${label.query}::${label.assetId}`, label);
    }
  }
  const assetIds = [
    ...new Set([...judgments.values()].map(({ assetId }) => assetId)),
  ];
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "******localhost:5433/art_explorer",
  });
  const rows = (
    await pool.query<AssetRow>(
      `SELECT asset.id, asset.media_url,
              embedding.jina_image_embedding::text AS local_vector
         FROM media_assets asset
         JOIN media_embeddings embedding ON embedding.asset_id = asset.id
        WHERE asset.id = ANY($1::text[])
          AND asset.media_url IS NOT NULL
          AND embedding.jina_image_embedding IS NOT NULL
        ORDER BY asset.id`,
      [assetIds],
    )
  ).rows;
  await pool.end();
  const retainedAssetIds = new Set(rows.map(({ id }) => id));
  for (const [key, label] of judgments) {
    if (!retainedAssetIds.has(label.assetId)) judgments.delete(key);
  }
  const queries = [
    ...new Set([...judgments.values()].map(({ query }) => query)),
  ];
  console.error(
    `[Hosted pilot] retained ${rows.length}/${assetIds.length} judged assets after catalog filtering`,
  );

  const maxPixels = Number(process.env.JINA_IMAGE_MAX_PIXELS ?? 800);
  const cachePath = path.resolve(
    process.env.HOSTED_JINA_PILOT_CACHE ??
      `.cache/image-model-eval/jina-hosted-${maxPixels}.json`,
  );
  let cache: Cache = {
    model: "jina-clip-v2",
    maxPixels,
    assets: {},
  };
  try {
    const existing = JSON.parse(await readFile(cachePath, "utf8")) as Cache;
    if (
      existing.model === cache.model &&
      existing.maxPixels === cache.maxPixels
    ) {
      cache = existing;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const hosted = new HostedJinaEmbeddingProvider();
  const batchSize = Number(process.env.EMBEDDING_BATCH_SIZE ?? 8);
  const batchDelayMs = Number(process.env.JINA_PILOT_BATCH_DELAY_MS ?? 0);
  const pending = rows.filter(
    (row) => cache.assets[row.id]?.mediaUrl !== row.media_url,
  );
  for (let start = 0; start < pending.length; start += batchSize) {
    const batch = pending.slice(start, start + batchSize);
    const inputs = await Promise.all(
      batch.map(({ media_url }) =>
        prepareHostedJinaImage(media_url, maxPixels),
      ),
    );
    const vectors = await hosted.embedImages(inputs);
    for (const [index, row] of batch.entries()) {
      cache.assets[row.id] = {
        mediaUrl: row.media_url,
        vector: vectors[index],
      };
    }
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(cache)}\n`);
    console.error(
      `[Hosted pilot] ${Math.min(start + batchSize, pending.length)}/${pending.length}`,
    );
    if (start + batchSize < pending.length && batchDelayMs > 0) {
      await sleep(batchDelayMs);
    }
  }

  const local = new TransformersEmbeddingProvider("jinaai/jina-clip-v2");
  const [localQueries, hostedQueries] = await Promise.all([
    local.embedImageText(queries),
    hosted.embedImageText(queries),
  ]);
  const localVectors = new Map(
    rows.map(({ id, local_vector }) => [id, parseVector(local_vector)]),
  );
  const hostedVectors = new Map(
    rows.map(({ id }) => [id, cache.assets[id].vector]),
  );
  const models = [
    { name: "local-q4", queries: localQueries, assets: localVectors },
    {
      name: `hosted-${maxPixels}px`,
      queries: hostedQueries,
      assets: hostedVectors,
    },
  ];
  const summaries = [];
  for (const model of models) {
    let strict = 0;
    let lenient = 0;
    let strictNdcg = 0;
    let lenientNdcg = 0;
    let ndcgQueries = 0;
    let rankedCount = 0;
    const rankings = [];
    for (const [queryIndex, query] of queries.entries()) {
      const labels = [...judgments.values()].filter(
        (label) => label.query === query,
      );
      const ranked = labels
        .map((label) => ({
          ...label,
          score: dot(
            model.queries[queryIndex],
            model.assets.get(label.assetId) ?? [],
          ),
        }))
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.assetId.localeCompare(right.assetId),
        )
        .slice(0, 5);
      rankedCount += ranked.length;
      strict += ranked.reduce(
        (sum, { label }) => sum + gain(label, false),
        0,
      );
      lenient += ranked.reduce(
        (sum, { label }) => sum + gain(label, true),
        0,
      );
      const idealStrict = dcg(
        labels
          .map(({ label }) => gain(label, false))
          .sort((left, right) => right - left)
          .slice(0, 5),
      );
      const idealLenient = dcg(
        labels
          .map(({ label }) => gain(label, true))
          .sort((left, right) => right - left)
          .slice(0, 5),
      );
      if (idealStrict || idealLenient) {
        strictNdcg += idealStrict
          ? dcg(ranked.map(({ label }) => gain(label, false))) / idealStrict
          : 0;
        lenientNdcg += idealLenient
          ? dcg(ranked.map(({ label }) => gain(label, true))) / idealLenient
          : 0;
        ndcgQueries += 1;
      }
      rankings.push({
        query,
        candidates: ranked.map(({ assetId, label, score }) => ({
          assetId,
          label,
          score,
        })),
      });
    }
    summaries.push({
      model: model.name,
      strictPrecisionAt5: strict / rankedCount,
      lenientPrecisionAt5: lenient / rankedCount,
      strictNdcgAt5: strictNdcg / ndcgQueries,
      lenientNdcgAt5: lenientNdcg / ndcgQueries,
      rankings,
    });
  }
  console.table(
    summaries.map(({ rankings: _, ...summary }) => summary),
  );
  console.log(
    JSON.stringify({ queries, assetCount: rows.length, summaries }, null, 2),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
