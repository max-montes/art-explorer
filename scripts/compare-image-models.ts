import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { Pool } from "pg";
import {
  AutoModel,
  AutoProcessor,
  RawImage,
} from "@huggingface/transformers";
import type { MediaAsset } from "../src/lib/catalog/types";
import { TransformersEmbeddingProvider } from "../src/lib/retrieval/providers";

type Judgment = "relevant" | "unsure" | "not_relevant";
type QueryMode = "text" | "image";

interface EvalQuery {
  phase: "retrospective" | "prospective";
  group: string;
  mode: QueryMode;
  query: string;
  embeddingQuery?: string;
  anchorTitle?: string;
}

interface EvalConfig {
  queries: EvalQuery[];
}

interface EvalLabel {
  query: string;
  assetId: string;
  rank: number;
  label: Judgment;
  title: string;
}

interface EvalExport {
  labels: EvalLabel[];
}

interface AssetRow {
  id: string;
  catalog_payload: MediaAsset;
  image_embedding: string;
}

interface TensorLike {
  dims: number[];
  tolist(): unknown;
}

interface RankedLabel extends EvalLabel {
  score: number;
}

interface Metrics {
  strictNdcg: number | null;
  lenientNdcg: number | null;
  strictPairwise: number | null;
  lenientPairwise: number | null;
}

interface JinaCacheEntry {
  mediaUrl: string;
  vector: number[];
}

interface JinaCache {
  model: "jinaai/jina-clip-v2:q4";
  assets: Record<string, JinaCacheEntry>;
}

const isNumberMatrix = (value: unknown): value is number[][] =>
  Array.isArray(value) &&
  value.every(
    (row) =>
      Array.isArray(row) &&
      row.every((component) => typeof component === "number"),
  );

const tensorRows = (value: unknown, name: string): number[][] => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("tolist" in value) ||
    typeof value.tolist !== "function"
  ) {
    throw new Error(`${name} did not return a tensor.`);
  }
  const rows = (value as TensorLike).tolist();
  if (!isNumberMatrix(rows)) {
    throw new Error(`${name} returned an invalid tensor shape.`);
  }
  return rows;
};

const normalize = (vector: number[]) => {
  const magnitude = Math.sqrt(
    vector.reduce((sum, component) => sum + component * component, 0),
  );
  if (magnitude === 0) throw new Error("Cannot normalize a zero vector.");
  return vector.map((component) => component / magnitude);
};

const truncate = (vectors: number[][], dimensions: number) =>
  vectors.map((vector) => normalize(vector.slice(0, dimensions)));

const cosine = (left: number[], right: number[]) => {
  if (left.length !== right.length) {
    throw new Error(
      `Vector dimension mismatch: ${left.length} versus ${right.length}.`,
    );
  }
  return left.reduce(
    (sum, component, index) => sum + component * right[index],
    0,
  );
};

const gain = (label: Judgment, lenient: boolean) =>
  label === "relevant" ? 1 : label === "unsure" && lenient ? 0.5 : 0;

const dcg = (grades: number[]) =>
  grades.reduce(
    (sum, grade, index) => sum + grade / Math.log2(index + 2),
    0,
  );

const ndcg = (labels: RankedLabel[], lenient: boolean) => {
  const grades = labels.map(({ label }) => gain(label, lenient));
  const ideal = dcg([...grades].sort((a, b) => b - a));
  return ideal === 0 ? null : dcg(grades) / ideal;
};

const pairwiseAccuracy = (labels: RankedLabel[], lenient: boolean) => {
  let comparable = 0;
  let correct = 0;
  for (let left = 0; left < labels.length; left += 1) {
    for (let right = left + 1; right < labels.length; right += 1) {
      const leftGain = gain(labels[left].label, lenient);
      const rightGain = gain(labels[right].label, lenient);
      if (leftGain === rightGain) continue;
      comparable += 1;
      if (leftGain > rightGain) correct += 1;
    }
  }
  return comparable === 0 ? null : correct / comparable;
};

const metrics = (labels: RankedLabel[]): Metrics => ({
  strictNdcg: ndcg(labels, false),
  lenientNdcg: ndcg(labels, true),
  strictPairwise: pairwiseAccuracy(labels, false),
  lenientPairwise: pairwiseAccuracy(labels, true),
});

const mean = (values: Array<number | null>) => {
  const present = values.filter((value): value is number => value !== null);
  return present.length
    ? present.reduce((sum, value) => sum + value, 0) / present.length
    : null;
};

const summarize = (byQuery: Map<string, Metrics>): Metrics => {
  const values = [...byQuery.values()];
  return {
    strictNdcg: mean(values.map((value) => value.strictNdcg)),
    lenientNdcg: mean(values.map((value) => value.lenientNdcg)),
    strictPairwise: mean(values.map((value) => value.strictPairwise)),
    lenientPairwise: mean(values.map((value) => value.lenientPairwise)),
  };
};

const formatMetric = (value: number | null) =>
  value === null ? "n/a" : value.toFixed(3);

const rankLabels = (
  labels: EvalLabel[],
  queryVector: number[],
  imageVectors: Map<string, number[]>,
) =>
  labels
    .map((label) => {
      const imageVector = imageVectors.get(label.assetId);
      if (!imageVector) {
        throw new Error(`Missing image embedding for ${label.assetId}.`);
      }
      return { ...label, score: cosine(queryVector, imageVector) };
    })
    .sort((left, right) => right.score - left.score);

const parsePgVector = (value: string) =>
  value
    .slice(1, -1)
    .split(",")
    .map(Number);

const withoutAnchor = (
  labels: EvalLabel[],
  query: EvalQuery,
  anchorAssetId?: string,
) =>
  query.mode === "image"
    ? labels.filter(({ assetId }) => assetId !== anchorAssetId)
    : labels;

async function main() {
  const labelsPath = process.argv[2];
  if (!labelsPath) {
    throw new Error(
      "Pass an evaluator label export: npx tsx scripts/compare-image-models.ts /path/to/labels.json",
    );
  }

  const configPath = path.resolve(
    process.argv[3] ?? "curation/image-model-eval.json",
  );
  const cachePath = path.resolve(
    process.env.JINA_PILOT_CACHE ??
      ".cache/image-model-eval/jina-clip-v2-q4.json",
  );
  const [parsed, config] = await Promise.all([
    readFile(labelsPath, "utf8").then(
      (value) => JSON.parse(value) as EvalExport,
    ),
    readFile(configPath, "utf8").then(
      (value) => JSON.parse(value) as EvalConfig,
    ),
  ]);
  const queries = config.queries.filter(
    ({ phase, query }) =>
      phase === "retrospective" &&
      parsed.labels.some((label) => label.query === query),
  );
  const querySet = new Set(queries.map(({ query }) => query));
  const labels = parsed.labels.filter(({ query }) => querySet.has(query));
  const groupedLabels = new Map(
    queries.map(({ query }) => [
      query,
      labels
        .filter((label) => label.query === query)
        .sort((left, right) => left.rank - right.rank),
    ]),
  );
  for (const [query, queryLabels] of groupedLabels) {
    if (queryLabels.length < 2) {
      throw new Error(
        `Expected at least two judgments for "${query}", found ${queryLabels.length}.`,
      );
    }
  }

  const assetIds = [...new Set(labels.map(({ assetId }) => assetId))];
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "******localhost:5433/art_explorer",
  });
  const result = await pool.query<AssetRow>(
    `SELECT asset.id,
            asset.catalog_payload,
            embedding.image_embedding::text AS image_embedding
       FROM media_assets asset
       JOIN media_embeddings embedding ON embedding.asset_id = asset.id
      WHERE asset.id = ANY($1::text[])
        AND embedding.image_embedding IS NOT NULL`,
    [assetIds],
  );
  await pool.end();
  if (result.rows.length !== assetIds.length) {
    throw new Error(
      `Found ${result.rows.length}/${assetIds.length} labeled assets in PostgreSQL.`,
    );
  }

  const assets = new Map(
    result.rows.map(({ id, catalog_payload }) => [id, catalog_payload]),
  );
  const imageUrls = assetIds.map((id) => {
    const url = assets.get(id)?.source.mediaUrl;
    if (!url) throw new Error(`Asset ${id} has no image URL.`);
    return url;
  });

  const timings: Record<string, number> = {};
  let started = performance.now();
  const siglip = new TransformersEmbeddingProvider();
  const textQueries = queries.filter(({ mode }) => mode === "text");
  const siglipQueryRows = await siglip.embedImageText(
    textQueries.map(({ query, embeddingQuery }) => embeddingQuery ?? query),
  );
  const siglipTextVectors = new Map(
    textQueries.map(({ query }, index) => [query, siglipQueryRows[index]]),
  );
  const siglipImageVectors = new Map(
    result.rows.map(({ id, image_embedding }) => [
      id,
      parsePgVector(image_embedding),
    ]),
  );
  timings.siglipSeconds = (performance.now() - started) / 1000;

  let jinaCache: JinaCache = {
    model: "jinaai/jina-clip-v2:q4",
    assets: {},
  };
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as JinaCache;
    if (cached.model === jinaCache.model) jinaCache = cached;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  started = performance.now();
  const jinaModelId = "jinaai/jina-clip-v2";
  const jinaThreads = Number(process.env.JINA_PILOT_THREADS ?? 4);
  if (!Number.isInteger(jinaThreads) || jinaThreads < 1) {
    throw new Error("JINA_PILOT_THREADS must be a positive integer.");
  }
  const [jinaProcessor, jinaModel] = await Promise.all([
    AutoProcessor.from_pretrained(jinaModelId),
    AutoModel.from_pretrained(jinaModelId, {
      dtype: "q4",
      session_options: {
        intraOpNumThreads: jinaThreads,
        interOpNumThreads: 1,
        executionMode: "sequential",
      },
    }),
  ]);
  timings.jinaLoadSeconds = (performance.now() - started) / 1000;

  started = performance.now();
  const queryInputs = await jinaProcessor(
    textQueries.map(({ query, embeddingQuery }) => embeddingQuery ?? query),
    null,
    {
    padding: true,
    truncation: true,
    },
  );
  const queryOutput = await jinaModel(queryInputs);
  const jinaQueryRows = tensorRows(
    queryOutput.l2norm_text_embeddings,
    "Jina text encoder",
  );
  const jinaTextVectors = new Map(
    textQueries.map(({ query }, index) => [query, jinaQueryRows[index]]),
  );
  timings.jinaTextSeconds = (performance.now() - started) / 1000;

  const jinaImageVectors = new Map<string, number[]>();
  for (const [index, assetId] of assetIds.entries()) {
    const cached = jinaCache.assets[assetId];
    if (cached?.mediaUrl === imageUrls[index]) {
      jinaImageVectors.set(assetId, cached.vector);
    }
  }
  const pendingAssetIds = assetIds.filter(
    (assetId) => !jinaImageVectors.has(assetId),
  );
  const batchSize = Number(process.env.JINA_PILOT_BATCH_SIZE ?? 4);
  started = performance.now();
  for (let offset = 0; offset < pendingAssetIds.length; offset += batchSize) {
    const batchIds = pendingAssetIds.slice(offset, offset + batchSize);
    const urls = batchIds.map((assetId) => {
      const url = assets.get(assetId)?.source.mediaUrl;
      if (!url) throw new Error(`Asset ${assetId} has no image URL.`);
      return url;
    });
    const images = await Promise.all(urls.map((url) => RawImage.read(url)));
    const imageInputs = await jinaProcessor(null, images);
    const imageOutput = await jinaModel(imageInputs);
    const vectors = tensorRows(
      imageOutput.l2norm_image_embeddings,
      "Jina image encoder",
    );
    for (const [index, assetId] of batchIds.entries()) {
      const vector = vectors[index];
      jinaImageVectors.set(assetId, vector);
      jinaCache.assets[assetId] = { mediaUrl: urls[index], vector };
    }
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(jinaCache), "utf8");
    console.error(
      `Jina images: ${Math.min(offset + batchSize, pendingAssetIds.length)}/${pendingAssetIds.length} new (${jinaImageVectors.size}/${assetIds.length} cached)`,
    );
  }
  timings.jinaImageSeconds = (performance.now() - started) / 1000;

  const vectorsByModel = new Map<string, Map<string, number[]>>([
    [
      "siglip-768",
      siglipImageVectors,
    ],
    [
      "jina-1024",
      jinaImageVectors,
    ],
    [
      "jina-256",
      new Map(
        [...jinaImageVectors].map(([id, vector]) => [
          id,
          truncate([vector], 256)[0],
        ]),
      ),
    ],
  ]);

  const resultsByModel = new Map<string, Map<string, Metrics>>();
  for (const [model, imageVectors] of vectorsByModel) {
    const byQuery = new Map<string, Metrics>();
    console.log(`\n${model}`);
    for (const queryConfig of queries) {
      const { query } = queryConfig;
      const sourceVectors =
        model === "siglip-768" ? siglipTextVectors : jinaTextVectors;
      const queryLabels = groupedLabels.get(query) ?? [];
      const anchor =
        queryConfig.mode === "image"
          ? queryLabels.find(({ rank }) => rank === 1)
          : undefined;
      const fullQueryVector =
        queryConfig.mode === "image"
          ? anchor
            ? imageVectors.get(anchor.assetId)
            : undefined
          : sourceVectors.get(query);
      if (!fullQueryVector) {
        throw new Error(`Missing ${model} query vector for "${query}".`);
      }
      const queryVector =
        model === "jina-256"
          ? truncate([fullQueryVector], 256)[0]
          : fullQueryVector;
      const ranked = rankLabels(
        withoutAnchor(queryLabels, queryConfig, anchor?.assetId),
        queryVector,
        imageVectors,
      );
      const resultMetrics = metrics(ranked);
      byQuery.set(query, resultMetrics);
      console.log(
        `  ${query.padEnd(12)} nDCG ${formatMetric(resultMetrics.strictNdcg)}/${formatMetric(resultMetrics.lenientNdcg)}  ` +
          ranked
            .map(
              ({ title, label, score }) =>
                `${title} [${label}, ${score.toFixed(3)}]`,
            )
            .join(" | "),
      );
    }
    resultsByModel.set(model, byQuery);
  }

  console.log("\nMacro metrics (strict/lenient)");
  for (const [model, byQuery] of resultsByModel) {
    const aggregate = summarize(byQuery);
    console.log(
      `  ${model.padEnd(11)} nDCG ${formatMetric(aggregate.strictNdcg)}/${formatMetric(aggregate.lenientNdcg)}  ` +
        `pairwise ${formatMetric(aggregate.strictPairwise)}/${formatMetric(aggregate.lenientPairwise)}`,
    );
  }
  const groups = [...new Set(queries.map(({ group }) => group))];
  console.log("\nMetrics by query group (strict/lenient nDCG)");
  for (const group of groups) {
    const groupQueries = new Set(
      queries
        .filter((query) => query.group === group)
        .map(({ query }) => query),
    );
    const parts = [...resultsByModel].map(([model, byQuery]) => {
      const aggregate = summarize(
        new Map([...byQuery].filter(([query]) => groupQueries.has(query))),
      );
      return `${model} ${formatMetric(aggregate.strictNdcg)}/${formatMetric(aggregate.lenientNdcg)}`;
    });
    console.log(`  ${group.padEnd(20)} ${parts.join("  ")}`);
  }
  console.log("\nTimings");
  for (const [name, seconds] of Object.entries(timings)) {
    console.log(`  ${name.padEnd(18)} ${seconds.toFixed(2)}s`);
  }
  console.log(
    `  jinaPerNewImage    ${
      pendingAssetIds.length
        ? (timings.jinaImageSeconds / pendingAssetIds.length).toFixed(2)
        : "n/a"
    }s`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
