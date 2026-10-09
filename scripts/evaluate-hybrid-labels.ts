import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { TransformersEmbeddingProvider } from "../src/lib/retrieval/providers";

type Judgment = "relevant" | "unsure" | "not_relevant";

interface Label {
  query: string;
  assetId: string;
  label: Judgment;
  rankingMethod?: string;
}

interface AssetRow {
  asset_id: string;
  image_vector: string;
  title_vector: string;
}

const parseVector = (value: string) =>
  value
    .slice(1, -1)
    .split(",")
    .map(Number);

const dot = (left: number[], right: number[]) =>
  left.reduce(
    (sum, component, index) => sum + component * right[index],
    0,
  );

const gain = (label: Judgment, lenient: boolean) =>
  label === "relevant" ? 1 : label === "unsure" && lenient ? 0.5 : 0;

const dcg = (grades: number[]) =>
  grades.reduce(
    (sum, grade, index) => sum + grade / Math.log2(index + 2),
    0,
  );

const ndcgAt5 = (labels: Judgment[], lenient: boolean) => {
  const grades = labels.slice(0, 5).map((label) => gain(label, lenient));
  const ideal = dcg(
    [...labels]
      .map((label) => gain(label, lenient))
      .sort((left, right) => right - left)
      .slice(0, 5),
  );
  return ideal === 0 ? null : dcg(grades) / ideal;
};

const precisionAt5 = (labels: Judgment[], lenient: boolean) =>
  labels
    .slice(0, 5)
    .filter((label) =>
      lenient ? label !== "not_relevant" : label === "relevant",
    ).length / Math.min(5, labels.length);

const mean = (values: Array<number | null>) => {
  const present = values.filter((value): value is number => value !== null);
  return present.reduce((sum, value) => sum + value, 0) / present.length;
};

async function main() {
  const labelsPath = process.argv[2];
  if (!labelsPath) {
    throw new Error("Pass an evaluator label export.");
  }
  const rankingMethod =
    process.env.LABEL_RANKING_METHOD ?? "blind:image-model-v1";
  const parsed = JSON.parse(
    await readFile(path.resolve(labelsPath), "utf8"),
  ) as { labels: Label[] };
  const labels = parsed.labels.filter(
    (label) => !rankingMethod || label.rankingMethod === rankingMethod,
  );
  const queries = [...new Set(labels.map(({ query }) => query))];
  if (!queries.length) {
    throw new Error(`No labels matched ranking method "${rankingMethod}".`);
  }

  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "******localhost:5432/art_explorer",
  });
  const assetIds = [...new Set(labels.map(({ assetId }) => assetId))];
  const rows = (
    await pool.query<AssetRow>(
      `SELECT asset_id,
              jina_image_embedding::text AS image_vector,
              jina_title_embedding::text AS title_vector
         FROM media_embeddings
        WHERE asset_id = ANY($1::text[])
          AND jina_image_embedding IS NOT NULL
          AND jina_title_embedding IS NOT NULL`,
      [assetIds],
    )
  ).rows;
  await pool.end();
  const vectors = new Map(
    rows.map(({ asset_id, image_vector, title_vector }) => [
      asset_id,
      {
        image: parseVector(image_vector),
        title: parseVector(title_vector),
      },
    ]),
  );
  const provider = new TransformersEmbeddingProvider(
    "jinaai/jina-clip-v2",
    true,
  );
  const queryVectors = await provider.embedImageText(queries);
  const variants = ["image", "title", "rrf-10", "rrf-20", "rrf-40"] as const;
  const metrics = new Map<
    (typeof variants)[number],
    Array<{
      strictPrecision: number;
      lenientPrecision: number;
      strictNdcg: number | null;
      lenientNdcg: number | null;
    }>
  >(variants.map((variant) => [variant, []]));

  for (const [queryIndex, query] of queries.entries()) {
    const queryLabels = labels.filter((label) => label.query === query);
    const scored = queryLabels.flatMap((label) => {
      const vector = vectors.get(label.assetId);
      return vector
        ? [
            {
              ...label,
              imageScore: dot(queryVectors[queryIndex], vector.image),
              titleScore: dot(queryVectors[queryIndex], vector.title),
            },
          ]
        : [];
    });
    const imageRanks = new Map(
      [...scored]
        .sort((left, right) => right.imageScore - left.imageScore)
        .map(({ assetId }, index) => [assetId, index + 1]),
    );
    const titleRanks = new Map(
      [...scored]
        .sort((left, right) => right.titleScore - left.titleScore)
        .map(({ assetId }, index) => [assetId, index + 1]),
    );

    for (const variant of variants) {
      const score = (item: (typeof scored)[number]) => {
        if (variant === "image") return item.imageScore;
        if (variant === "title") return item.titleScore;
        const k = Number(variant.split("-")[1]);
        return (
          1 / (k + (imageRanks.get(item.assetId) ?? scored.length + 1)) +
          1 / (k + (titleRanks.get(item.assetId) ?? scored.length + 1))
        );
      };
      const ranked = [...scored].sort((left, right) => {
        return score(right) - score(left);
      });
      const judgments = ranked.map(({ label }) => label);
      metrics.get(variant)?.push({
        strictPrecision: precisionAt5(judgments, false),
        lenientPrecision: precisionAt5(judgments, true),
        strictNdcg: ndcgAt5(judgments, false),
        lenientNdcg: ndcgAt5(judgments, true),
      });
    }
  }

  console.table(
    variants.map((variant) => {
      const values = metrics.get(variant) ?? [];
      return {
        variant,
        queries: values.length,
        strictPrecisionAt5: mean(
          values.map(({ strictPrecision }) => strictPrecision),
        ),
        lenientPrecisionAt5: mean(
          values.map(({ lenientPrecision }) => lenientPrecision),
        ),
        strictNdcgAt5: mean(values.map(({ strictNdcg }) => strictNdcg)),
        lenientNdcgAt5: mean(values.map(({ lenientNdcg }) => lenientNdcg)),
      };
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
