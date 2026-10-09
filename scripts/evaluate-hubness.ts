import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import type { MediaAsset } from "../src/lib/catalog/types";
import { TransformersEmbeddingProvider } from "../src/lib/retrieval/providers";

interface Label {
  query: string;
  assetId: string;
  label: "relevant" | "unsure" | "not_relevant";
}

interface AssetVector {
  id: string;
  title: string;
  vector: number[];
  asset: MediaAsset;
}

const dot = (left: number[], right: number[]) => {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += left[index] * right[index];
  }
  return score;
};

const parseVector = (value: string) =>
  value
    .slice(1, -1)
    .split(",")
    .map(Number);

async function main() {
  const labelsPath = process.argv[2];
  if (!labelsPath) {
    throw new Error("Pass the exported full-index labels JSON.");
  }
  const labels = (
    JSON.parse(await readFile(path.resolve(labelsPath), "utf8")) as {
      labels: Label[];
    }
  ).labels;
  const queries = [...new Set(labels.map(({ query }) => query))];
  const labelMap = new Map(
    labels.map((label) => [`${label.query}::${label.assetId}`, label.label]),
  );

  const legacyEval = JSON.parse(
    await readFile("curation/eval.json", "utf8"),
  ) as Array<{ query?: string }>;
  const imageEval = JSON.parse(
    await readFile("curation/image-model-eval.json", "utf8"),
  ) as {
    queries: Array<{
      phase: string;
      mode: string;
      query: string;
      embeddingQuery?: string;
    }>;
  };
  const querySet = new Set(queries);
  const referenceQueries = [
    ...legacyEval.flatMap(({ query }) => (query ? [query] : [])),
    ...imageEval.queries.flatMap((entry) =>
      entry.phase === "retrospective" && entry.mode === "text"
        ? [entry.embeddingQuery ?? entry.query]
        : [],
    ),
  ].filter(
    (query, index, all) =>
      all.indexOf(query) === index && !querySet.has(query),
  );

  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "******localhost:5433/art_explorer",
  });
  const assets = (
    await pool.query<{
      id: string;
      title: string;
      vector: string;
      asset: MediaAsset;
    }>(
      `SELECT asset.id, asset.title, asset.catalog_payload AS asset,
              embedding.jina_image_embedding::text AS vector
         FROM media_assets asset
         JOIN media_embeddings embedding ON embedding.asset_id = asset.id
        WHERE embedding.jina_image_embedding IS NOT NULL
        ORDER BY asset.id`,
    )
  ).rows.map(
    ({ id, title, vector, asset }): AssetVector => ({
      id,
      title,
      vector: parseVector(vector),
      asset,
    }),
  );
  await pool.end();

  const provider = new TransformersEmbeddingProvider("jinaai/jina-clip-v2");
  const textVectors = await provider.embedImageText([
    ...queries,
    ...referenceQueries,
  ]);
  const queryVectors = textVectors.slice(0, queries.length);
  const referenceVectors = textVectors.slice(queries.length);

  const baselines = assets.map(({ vector }) => {
    const similarities = referenceVectors
      .map((reference) => dot(reference, vector))
      .sort((left, right) => right - left);
    const mean =
      similarities.reduce((sum, score) => sum + score, 0) /
      similarities.length;
    const variance =
      similarities.reduce(
        (sum, score) => sum + (score - mean) * (score - mean),
        0,
      ) / similarities.length;
    return {
      mean,
      standardDeviation: Math.sqrt(variance),
      top5Mean:
        similarities.slice(0, 5).reduce((sum, score) => sum + score, 0) / 5,
      top10Mean:
        similarities.slice(0, 10).reduce((sum, score) => sum + score, 0) / 10,
    };
  });

  const variants: Array<{
    name: string;
    score: (raw: number, assetIndex: number) => number;
  }> = [
    { name: "raw", score: (raw) => raw },
    ...[0.25, 0.5, 0.75, 1].map((alpha) => ({
      name: `mean-${alpha}`,
      score: (raw: number, index: number) =>
        raw - alpha * baselines[index].mean,
    })),
    ...[0.25, 0.5, 0.75, 1].map((alpha) => ({
      name: `top10-${alpha}`,
      score: (raw: number, index: number) =>
        raw - alpha * baselines[index].top10Mean,
    })),
    ...[0.25, 0.5, 0.75, 1].map((alpha) => ({
      name: `top5-${alpha}`,
      score: (raw: number, index: number) =>
        raw - alpha * baselines[index].top5Mean,
    })),
    {
      name: "z-score",
      score: (raw, index) =>
        (raw - baselines[index].mean) /
        Math.max(0.0001, baselines[index].standardDeviation),
    },
  ];

  const results = variants.map((variant) => {
    const occurrences = new Map<string, number>();
    let judged = 0;
    let relevant = 0;
    let lenient = 0;
    const rankings = queries.map((query, queryIndex) => {
      const ranked = assets
        .map((asset, assetIndex) => {
          const raw = dot(queryVectors[queryIndex], asset.vector);
          return {
            id: asset.id,
            title: asset.title,
            raw,
            score: variant.score(raw, assetIndex),
          };
        })
        .sort(
          (left, right) =>
            right.score - left.score || left.id.localeCompare(right.id),
        )
        .slice(0, 5);
      for (const asset of ranked) {
        occurrences.set(asset.id, (occurrences.get(asset.id) ?? 0) + 1);
        const label = labelMap.get(`${query}::${asset.id}`);
        if (!label) continue;
        judged += 1;
        if (label === "relevant") relevant += 1;
        if (label !== "not_relevant") lenient += 1;
      }
      return { query, ranked };
    });
    const frequencies = [...occurrences.values()];
    return {
      name: variant.name,
      uniqueAssets: occurrences.size,
      maximumFrequency: Math.max(...frequencies),
      repeatedSlots: frequencies.reduce(
        (sum, frequency) => sum + Math.max(0, frequency - 1),
        0,
      ),
      judgedCoverage: judged / (queries.length * 5),
      strictPrecisionAmongJudged: judged ? relevant / judged : null,
      lenientPrecisionAmongJudged: judged ? lenient / judged : null,
      rankings,
    };
  });

  const outputPath = ".cache/image-model-eval/hubness-experiment.json";
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        labelsPath,
        queryCount: queries.length,
        referenceQueryCount: referenceQueries.length,
        assetCount: assets.length,
        results,
      },
      null,
      2,
    )}\n`,
  );
  const selectedVariant = process.env.HUBNESS_VARIANT ?? "mean-0.25";
  const selected = results.find(({ name }) => name === selectedVariant);
  if (!selected) {
    throw new Error(
      `Unknown HUBNESS_VARIANT "${selectedVariant}". Choose one of: ` +
        results.map(({ name }) => name).join(", "),
    );
  }
  const assetsById = new Map(assets.map(({ id, asset }) => [id, asset]));
  await writeFile(
    "public/hubness-eval-data.json",
    `${JSON.stringify(
      {
        version: 1,
        id: `jina-${selectedVariant.replaceAll(".", "")}-full-catalog`,
        generatedAt: new Date().toISOString(),
        blinded: true,
        candidateSource:
          `Full-catalog Jina hubness experiment using ${selectedVariant}`,
        seedLabels: selected.rankings.flatMap(({ query, ranked }) =>
          ranked.flatMap(({ id, title }, index) => {
            const label = labelMap.get(`${query}::${id}`);
            return label
              ? [
                  {
                    query,
                    assetId: id,
                    rank: index + 1,
                    label,
                    title,
                  },
                ]
              : [];
          }),
        ),
        queries: selected.rankings.map(({ query, ranked }) => ({
          query,
          candidates: ranked.map(({ id }) => {
            const asset = assetsById.get(id);
            if (!asset) throw new Error(`Missing catalog asset ${id}.`);
            return asset;
          }),
        })),
      },
      null,
      2,
    )}\n`,
  );
  console.table(
    results.map((result) => ({
      name: result.name,
      uniqueAssets: result.uniqueAssets,
      maximumFrequency: result.maximumFrequency,
      repeatedSlots: result.repeatedSlots,
      judgedCoverage: result.judgedCoverage,
      strictPrecisionAmongJudged: result.strictPrecisionAmongJudged,
      lenientPrecisionAmongJudged: result.lenientPrecisionAmongJudged,
    })),
  );
  console.log(`Wrote ${outputPath}`);
  console.log("Wrote public/hubness-eval-data.json");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
