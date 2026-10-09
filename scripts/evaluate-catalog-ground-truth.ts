import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { TransformersEmbeddingProvider } from "../src/lib/retrieval/providers";

type ModelName =
  | "jina-image"
  | "siglip-image"
  | "jina-title"
  | "jina-rrf-10"
  | "jina-rrf-20"
  | "jina-rrf-40";

interface QueryCase {
  group: "subject" | "creator" | "description" | "title";
  query: string;
  positives: Set<string>;
}

interface RankedResult {
  id: string;
  score: number;
}

const VISUAL_SUBJECTS = [
  "still life",
  "flowers",
  "fruit",
  "mountains",
  "trees",
  "birds",
  "sheep",
  "reading",
  "snow",
  "dancing",
  "farmers",
  "drinking",
  "evening",
  "animals",
  "vegetables",
  "night",
  "snakes",
  "sewing",
];

const toVector = (values: number[]) => `[${values.join(",")}]`;

const dcg = (relevances: number[]) =>
  relevances.reduce(
    (sum, relevance, index) =>
      sum + relevance / Math.log2(index + 2),
    0,
  );

const metrics = (ranking: RankedResult[], positives: Set<string>) => {
  const relevant = ranking.map(({ id }) => positives.has(id));
  const precisionAt5 =
    relevant.slice(0, 5).filter(Boolean).length / Math.min(5, ranking.length);
  const idealAt10 = dcg(
    Array.from(
      { length: Math.min(10, positives.size) },
      () => 1,
    ),
  );
  const ndcgAt10 =
    idealAt10 === 0
      ? 0
      : dcg(relevant.slice(0, 10).map((value) => (value ? 1 : 0))) /
        idealAt10;
  const firstRelevant = relevant.findIndex(Boolean);
  const reciprocalRank =
    firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1);
  const hitAt20 = relevant.slice(0, 20).some(Boolean) ? 1 : 0;
  return { precisionAt5, ndcgAt10, reciprocalRank, hitAt20 };
};

const mean = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

async function topMatches(
  client: PoolClient,
  column: "jina_image_embedding" | "image_embedding" | "jina_title_embedding",
  vector: number[],
  limit = 100,
): Promise<RankedResult[]> {
  const result = await client.query<{ asset_id: string; score: number }>(
    `SELECT asset_id, 1 - (${column} <=> $1::vector) AS score
       FROM media_embeddings
      WHERE ${column} IS NOT NULL
      ORDER BY ${column} <=> $1::vector, asset_id
      LIMIT $2`,
    [toVector(vector), limit],
  );
  return result.rows.map(({ asset_id, score }) => ({
    id: asset_id,
    score: Number(score),
  }));
}

const reciprocalRankFusion = (
  image: RankedResult[],
  title: RankedResult[],
  k: number,
) => {
  const scores = new Map<string, number>();
  for (const ranking of [image, title]) {
    for (const [index, { id }] of ranking.entries()) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    }
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort(
      (left, right) =>
        right.score - left.score || left.id.localeCompare(right.id),
    );
};

async function groundTruthCases(client: PoolClient): Promise<QueryCase[]> {
  const subjectRows = await client.query<{ label: string; asset_id: string }>(
    `SELECT lower(label.label) AS label, label.asset_id
       FROM asset_labels label
       JOIN media_embeddings embedding ON embedding.asset_id = label.asset_id
      WHERE label.label_type IN ('subject', 'association')
        AND lower(label.label) = ANY($1::text[])
        AND embedding.jina_image_embedding IS NOT NULL
        AND embedding.image_embedding IS NOT NULL
        AND embedding.jina_title_embedding IS NOT NULL`,
    [VISUAL_SUBJECTS],
  );
  const subjectAssets = new Map<string, Set<string>>(
    VISUAL_SUBJECTS.map((subject) => [subject, new Set()]),
  );
  for (const { label, asset_id } of subjectRows.rows) {
    subjectAssets.get(label)?.add(asset_id);
  }

  const creatorRows = await client.query<{
    creator: string;
    asset_ids: string[];
  }>(
    `SELECT asset.creator, array_agg(asset.id ORDER BY asset.id) AS asset_ids
       FROM media_assets asset
       JOIN media_embeddings embedding ON embedding.asset_id = asset.id
      WHERE asset.creator NOT IN ('Unknown', 'Unknown Creator', 'anonymous')
        AND embedding.jina_image_embedding IS NOT NULL
        AND embedding.image_embedding IS NOT NULL
        AND embedding.jina_title_embedding IS NOT NULL
      GROUP BY asset.creator
     HAVING count(*) BETWEEN 12 AND 100
        AND count(DISTINCT asset.source_provider) >= 4
      ORDER BY count(DISTINCT asset.source_provider) DESC, count(*) DESC
      LIMIT 20`,
  );
  const descriptionRows = await client.query<{
    id: string;
    description: string;
  }>(
    `WITH sampled AS (
       SELECT asset.id, asset.description,
              row_number() OVER (
                PARTITION BY asset.source_provider ORDER BY asset.id
              ) AS museum_rank
         FROM media_assets asset
         JOIN media_embeddings embedding ON embedding.asset_id = asset.id
        WHERE length(asset.description) BETWEEN 120 AND 500
          AND embedding.jina_image_embedding IS NOT NULL
          AND embedding.image_embedding IS NOT NULL
          AND embedding.jina_title_embedding IS NOT NULL
     )
     SELECT id, description
       FROM sampled
      WHERE museum_rank <= 10
      ORDER BY id`,
  );
  const titleRows = await client.query<{ id: string; title: string }>(
    `WITH sampled AS (
       SELECT asset.id, asset.title,
              row_number() OVER (
                PARTITION BY asset.source_provider ORDER BY asset.id
              ) AS museum_rank
         FROM media_assets asset
         JOIN media_embeddings embedding ON embedding.asset_id = asset.id
        WHERE length(asset.title) BETWEEN 8 AND 80
          AND lower(asset.title) <> 'untitled'
          AND embedding.jina_image_embedding IS NOT NULL
          AND embedding.image_embedding IS NOT NULL
          AND embedding.jina_title_embedding IS NOT NULL
     )
     SELECT id, title
       FROM sampled
      WHERE museum_rank <= 10
      ORDER BY id`,
  );

  return [
    ...[...subjectAssets]
      .filter(([, ids]) => ids.size >= 8)
      .map(([query, positives]): QueryCase => ({
        group: "subject",
        query,
        positives,
      })),
    ...creatorRows.rows.map(
      ({ creator, asset_ids }): QueryCase => ({
        group: "creator",
        query: creator,
        positives: new Set(asset_ids),
      }),
    ),
    ...descriptionRows.rows.map(
      ({ id, description }): QueryCase => ({
        group: "description",
        query: description,
        positives: new Set([id]),
      }),
    ),
    ...titleRows.rows.map(
      ({ id, title }): QueryCase => ({
        group: "title",
        query: title,
        positives: new Set([id]),
      }),
    ),
  ];
}

async function main() {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "******localhost:5432/art_explorer",
  });
  const client = await pool.connect();
  try {
    await client.query("SET enable_indexscan = off");
    await client.query("SET enable_bitmapscan = off");
    const cases = await groundTruthCases(client);
    const jina = new TransformersEmbeddingProvider(
      "jinaai/jina-clip-v2",
      true,
    );
    const siglip = new TransformersEmbeddingProvider(
      "Xenova/siglip-base-patch16-224",
    );
    const queries = cases.map(({ query }) => query);
    const [jinaVectors, siglipVectors] = await Promise.all([
      jina.embedImageText(queries),
      siglip.embedImageText(queries),
    ]);
    const models: ModelName[] = [
      "jina-image",
      "siglip-image",
      "jina-title",
      "jina-rrf-10",
      "jina-rrf-20",
      "jina-rrf-40",
    ];
    const results: Array<{
      group: QueryCase["group"];
      query: string;
      positives: number;
      rankings: Record<ModelName, RankedResult[]>;
    }> = [];

    for (const [index, testCase] of cases.entries()) {
      const jinaImage = await topMatches(
        client,
        "jina_image_embedding",
        jinaVectors[index],
      );
      const siglipImage = await topMatches(
        client,
        "image_embedding",
        siglipVectors[index],
      );
      const jinaTitle = await topMatches(
        client,
        "jina_title_embedding",
        jinaVectors[index],
      );
      results.push({
        group: testCase.group,
        query: testCase.query,
        positives: testCase.positives.size,
        rankings: {
          "jina-image": jinaImage,
          "siglip-image": siglipImage,
          "jina-title": jinaTitle,
          "jina-rrf-10": reciprocalRankFusion(jinaImage, jinaTitle, 10),
          "jina-rrf-20": reciprocalRankFusion(jinaImage, jinaTitle, 20),
          "jina-rrf-40": reciprocalRankFusion(jinaImage, jinaTitle, 40),
        },
      });
      if ((index + 1) % 20 === 0 || index + 1 === cases.length) {
        console.log(`[Ground truth] ${index + 1}/${cases.length} queries`);
      }
    }

    const summary = [...new Set(cases.map(({ group }) => group))].flatMap(
      (group) =>
        models.map((model) => {
          const groupResults = results.filter((result) => result.group === group);
          const scores = groupResults.map((result) => {
            const positives =
              cases.find(
                (testCase) =>
                  testCase.group === result.group &&
                  testCase.query === result.query,
              )?.positives ?? new Set<string>();
            return metrics(result.rankings[model], positives);
          });
          return {
            group,
            model,
            queries: groupResults.length,
            precisionAt5: mean(scores.map((score) => score.precisionAt5)),
            ndcgAt10: mean(scores.map((score) => score.ndcgAt10)),
            meanReciprocalRank: mean(
              scores.map((score) => score.reciprocalRank),
            ),
            hitAt20: mean(scores.map((score) => score.hitAt20)),
          };
        }),
    );
    const outputPath = path.resolve(
      process.env.CATALOG_GROUND_TRUTH_OUTPUT ??
        ".cache/image-model-eval/catalog-ground-truth.json",
    );
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          queryCount: cases.length,
          summary,
          results,
        },
        null,
        2,
      )}\n`,
    );
    console.table(
      summary.map((entry) => ({
        ...entry,
        precisionAt5: entry.precisionAt5.toFixed(3),
        ndcgAt10: entry.ndcgAt10.toFixed(3),
        meanReciprocalRank: entry.meanReciprocalRank.toFixed(3),
        hitAt20: entry.hitAt20.toFixed(3),
      })),
    );
    console.log(`Wrote ${outputPath}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
