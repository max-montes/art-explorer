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
  id: string;
  jina: string | null;
  siglip: string | null;
}

const PROMPTS = {
  raw: (query: string) => query,
  artwork: (query: string) => `artwork depicting ${query}`,
  painting: (query: string) => `painting depicting ${query}`,
  scene: (query: string) => `visual scene expressing ${query}`,
} as const;

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

async function labelsFrom(paths: string[]) {
  const judgments = new Map<string, Judgment>();
  for (const inputPath of paths) {
    const parsed = JSON.parse(
      await readFile(path.resolve(inputPath), "utf8"),
    ) as { labels?: Label[] };
    for (const label of parsed.labels ?? []) {
      if (
        label.rankingMethod !== "image" &&
        !label.rankingMethod?.startsWith("blind:")
      ) {
        continue;
      }
      judgments.set(`${label.query}::${label.assetId}`, label.label);
    }
  }
  return judgments;
}

async function main() {
  const labelPaths = process.argv.slice(2);
  if (!labelPaths.length) {
    throw new Error(
      "Pass one or more evaluator label exports. Later files override earlier judgments.",
    );
  }
  const judgments = await labelsFrom(labelPaths);
  const queries = [
    ...new Set([...judgments.keys()].map((key) => key.split("::", 1)[0])),
  ];
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "******localhost:5433/art_explorer",
  });
  const rows = (
    await pool.query<AssetRow>(
      `SELECT asset_id AS id,
              jina_image_embedding::text AS jina,
              image_embedding::text AS siglip
         FROM media_embeddings
        WHERE jina_image_embedding IS NOT NULL
           OR image_embedding IS NOT NULL
        ORDER BY asset_id`,
    )
  ).rows;
  await pool.end();

  const models = [
    {
      name: "jina",
      provider: new TransformersEmbeddingProvider("jinaai/jina-clip-v2"),
      vectors: rows.flatMap(({ id, jina }) =>
        jina ? [{ id, vector: parseVector(jina) }] : [],
      ),
    },
    {
      name: "jina-legacy",
      provider: new TransformersEmbeddingProvider(
        "jinaai/jina-clip-v2",
        false,
      ),
      vectors: rows.flatMap(({ id, jina }) =>
        jina ? [{ id, vector: parseVector(jina) }] : [],
      ),
    },
    {
      name: "siglip",
      provider: new TransformersEmbeddingProvider(
        "Xenova/siglip-base-patch16-224",
      ),
      vectors: rows.flatMap(({ id, siglip }) =>
        siglip ? [{ id, vector: parseVector(siglip) }] : [],
      ),
    },
  ];

  const summaries = [];
  for (const model of models) {
    for (const [promptName, prompt] of Object.entries(PROMPTS)) {
      const queryVectors = await model.provider.embedImageText(
        queries.map(prompt),
      );
      let judged = 0;
      let strict = 0;
      let lenient = 0;
      const unique = new Set<string>();
      const rankings = [];
      for (const [queryIndex, query] of queries.entries()) {
        const ranked = model.vectors
          .map(({ id, vector }) => ({
            id,
            score: dot(queryVectors[queryIndex], vector),
          }))
          .sort(
            (left, right) =>
              right.score - left.score || left.id.localeCompare(right.id),
          )
          .slice(0, 5);
        for (const { id } of ranked) {
          unique.add(id);
          const label = judgments.get(`${query}::${id}`);
          if (!label) continue;
          judged += 1;
          if (label === "relevant") strict += 1;
          if (label !== "not_relevant") lenient += 1;
        }
        rankings.push({ query, ids: ranked.map(({ id }) => id) });
      }
      summaries.push({
        model: model.name,
        prompt: promptName,
        corpusSize: model.vectors.length,
        judgedCoverage: judged / (queries.length * 5),
        strictPrecisionAmongJudged: judged ? strict / judged : null,
        lenientPrecisionAmongJudged: judged ? lenient / judged : null,
        uniqueTopFiveAssets: unique.size,
        rankings,
      });
    }
  }
  console.table(
    summaries.map((summary) => ({
      model: summary.model,
      prompt: summary.prompt,
      corpusSize: summary.corpusSize,
      judgedCoverage: summary.judgedCoverage,
      strictPrecisionAmongJudged: summary.strictPrecisionAmongJudged,
      lenientPrecisionAmongJudged: summary.lenientPrecisionAmongJudged,
      uniqueTopFiveAssets: summary.uniqueTopFiveAssets,
    })),
  );
  console.log(JSON.stringify({ queryCount: queries.length, summaries }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
