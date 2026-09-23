import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import {
  AutoModel,
  AutoProcessor,
  RawImage,
} from "@huggingface/transformers";
import type { MediaAsset, ScoredAsset } from "../src/lib/catalog/types";
import { TransformersEmbeddingProvider } from "../src/lib/retrieval/providers";

interface EvalQuery {
  phase: "retrospective" | "prospective";
  group: string;
  mode: "text" | "image";
  query: string;
  embeddingQuery?: string;
}

interface EvalConfig {
  version: number;
  queries: EvalQuery[];
}

interface SearchResponse {
  results: ScoredAsset[];
}

interface AssetRow {
  id: string;
  image_embedding: string;
}

interface TensorLike {
  tolist(): unknown;
}

interface CacheEntry {
  mediaUrl: string;
  vector: number[];
}

interface JinaCache {
  model: "jinaai/jina-clip-v2:q4";
  assets: Record<string, CacheEntry>;
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

const truncate = (vector: number[], dimensions: number) =>
  normalize(vector.slice(0, dimensions));

const cosine = (left: number[], right: number[]) =>
  left.reduce(
    (sum, component, index) => sum + component * right[index],
    0,
  );

const parsePgVector = (value: string) =>
  value
    .slice(1, -1)
    .split(",")
    .map(Number);

const stableHash = (value: string) => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const rank = (
  candidateIds: string[],
  queryVector: number[],
  imageVectors: Map<string, number[]>,
) =>
  candidateIds
    .map((assetId) => {
      const imageVector = imageVectors.get(assetId);
      if (!imageVector) {
        throw new Error(`Missing image vector for ${assetId}.`);
      }
      return { assetId, score: cosine(queryVector, imageVector) };
    })
    .sort((left, right) => right.score - left.score);

async function loadCache(cachePath: string): Promise<JinaCache> {
  const empty: JinaCache = {
    model: "jinaai/jina-clip-v2:q4",
    assets: {},
  };
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as JinaCache;
    return cached.model === empty.model ? cached : empty;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return empty;
    }
    throw error;
  }
}

async function main() {
  const configPath = path.resolve(
    process.argv[2] ?? "curation/image-model-eval.json",
  );
  const publicOutputPath = path.resolve(
    process.argv[3] ?? "public/image-model-eval-data.json",
  );
  const privateOutputPath = path.resolve(
    process.env.IMAGE_MODEL_EVAL_KEY ??
      ".cache/image-model-eval/prospective-key.json",
  );
  const cachePath = path.resolve(
    process.env.JINA_PILOT_CACHE ??
      ".cache/image-model-eval/jina-clip-v2-q4.json",
  );
  const searchOrigin =
    process.env.ART_EXPLORER_ORIGIN ?? "http://127.0.0.1:3000";
  const candidateLimit = Number(process.env.IMAGE_MODEL_CANDIDATES ?? 10);
  if (!Number.isInteger(candidateLimit) || candidateLimit < 5) {
    throw new Error("IMAGE_MODEL_CANDIDATES must be an integer of at least 5.");
  }

  const config = JSON.parse(
    await readFile(configPath, "utf8"),
  ) as EvalConfig;
  const queries = config.queries.filter(
    ({ phase, mode }) => phase === "prospective" && mode === "text",
  );
  const candidatesByQuery = new Map<string, Map<string, MediaAsset>>();
  for (const { query } of queries) {
    const url = new URL("/api/search", searchOrigin);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(candidateLimit));
    const response = await fetch(url);
    const payload = (await response.json()) as
      | SearchResponse
      | { error?: string };
    if (!response.ok || !("results" in payload)) {
      throw new Error(
        `Search failed for "${query}": ${
          "error" in payload ? payload.error : response.statusText
        }`,
      );
    }
    const payloads = [payload.results];
    candidatesByQuery.set(
      query,
      new Map(
        payloads
          .flat()
          .map(({ asset }) => [asset.id, asset] as const),
      ),
    );
  }

  const assets = new Map<string, MediaAsset>();
  for (const candidates of candidatesByQuery.values()) {
    for (const [id, asset] of candidates) assets.set(id, asset);
  }
  const assetIds = [...assets.keys()];
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "******localhost:5433/art_explorer",
  });
  const result = await pool.query<AssetRow>(
    `SELECT asset_id AS id, image_embedding::text AS image_embedding
       FROM media_embeddings
      WHERE asset_id = ANY($1::text[])
        AND image_embedding IS NOT NULL`,
    [assetIds],
  );
  await pool.end();
  if (result.rows.length !== assetIds.length) {
    throw new Error(
      `Found ${result.rows.length}/${assetIds.length} candidate SigLIP vectors.`,
    );
  }
  const siglipImages = new Map(
    result.rows.map(({ id, image_embedding }) => [
      id,
      parsePgVector(image_embedding),
    ]),
  );

  const siglip = new TransformersEmbeddingProvider();
  const embeddingTexts = queries.map(
    ({ query, embeddingQuery }) => embeddingQuery ?? query,
  );
  const siglipQueries = await siglip.embedImageText(embeddingTexts);

  const jinaCache = await loadCache(cachePath);
  const jinaImages = new Map<string, number[]>();
  for (const [assetId, asset] of assets) {
    const mediaUrl = asset.source.mediaUrl;
    const cached = jinaCache.assets[assetId];
    if (mediaUrl && cached?.mediaUrl === mediaUrl) {
      jinaImages.set(assetId, cached.vector);
    }
  }
  const pendingIds = assetIds.filter((id) => !jinaImages.has(id));
  const threads = Number(process.env.JINA_PILOT_THREADS ?? 4);
  const batchSize = Number(process.env.JINA_PILOT_BATCH_SIZE ?? 4);
  if (!Number.isInteger(threads) || threads < 1) {
    throw new Error("JINA_PILOT_THREADS must be a positive integer.");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("JINA_PILOT_BATCH_SIZE must be a positive integer.");
  }

  const [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(jinaCache.model.split(":")[0]),
    AutoModel.from_pretrained(jinaCache.model.split(":")[0], {
      dtype: "q4",
      session_options: {
        intraOpNumThreads: threads,
        interOpNumThreads: 1,
        executionMode: "sequential",
      },
    }),
  ]);
  const queryOutput = await model(
    await processor(embeddingTexts, null, {
      padding: true,
      truncation: true,
    }),
  );
  const jinaQueries = tensorRows(
    queryOutput.l2norm_text_embeddings,
    "Jina text encoder",
  ).map((vector) => truncate(vector, 256));

  const imageStartedAt = performance.now();
  for (let offset = 0; offset < pendingIds.length; offset += batchSize) {
    const batchIds = pendingIds.slice(offset, offset + batchSize);
    const urls = batchIds.map((assetId) => {
      const url = assets.get(assetId)?.source.mediaUrl;
      if (!url) throw new Error(`Asset ${assetId} has no image URL.`);
      return url;
    });
    const images = await Promise.all(urls.map((url) => RawImage.read(url)));
    const output = await model(await processor(null, images));
    const vectors = tensorRows(
      output.l2norm_image_embeddings,
      "Jina image encoder",
    );
    for (const [index, assetId] of batchIds.entries()) {
      const vector = vectors[index];
      jinaImages.set(assetId, vector);
      jinaCache.assets[assetId] = { mediaUrl: urls[index], vector };
    }
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(jinaCache), "utf8");
    console.error(
      `Jina images: ${Math.min(offset + batchSize, pendingIds.length)}/${pendingIds.length} new`,
    );
  }

  const evaluationId = `image-model-v${config.version}`;
  const publicQueries = [];
  const privateQueries = [];
  for (const [index, queryConfig] of queries.entries()) {
    const candidates = candidatesByQuery.get(queryConfig.query);
    if (!candidates) {
      throw new Error(`Missing candidates for "${queryConfig.query}".`);
    }
    const candidateIds = [...candidates.keys()];
    const siglipRanking = rank(
      candidateIds,
      siglipQueries[index],
      siglipImages,
    );
    const jinaRanking = rank(
      candidateIds,
      jinaQueries[index],
      new Map(
        candidateIds.map((id) => {
          const vector = jinaImages.get(id);
          if (!vector) throw new Error(`Missing Jina vector for ${id}.`);
          return [id, truncate(vector, 256)];
        }),
      ),
    );
    const evaluationIds = [
      ...new Set([
        ...siglipRanking.slice(0, 5).map(({ assetId }) => assetId),
        ...jinaRanking.slice(0, 5).map(({ assetId }) => assetId),
      ]),
    ].sort(
      (left, right) =>
        stableHash(`${evaluationId}:${queryConfig.query}:${left}`) -
        stableHash(`${evaluationId}:${queryConfig.query}:${right}`),
    );
    publicQueries.push({
      query: queryConfig.query,
      group: queryConfig.group,
      candidates: evaluationIds.map((id) => candidates.get(id)),
    });
    privateQueries.push({
      query: queryConfig.query,
      group: queryConfig.group,
      candidatePoolSize: candidateIds.length,
      rankings: {
        siglip768: siglipRanking.slice(0, 5),
        jina256: jinaRanking.slice(0, 5),
      },
    });
  }

  await Promise.all([
    mkdir(path.dirname(publicOutputPath), { recursive: true }),
    mkdir(path.dirname(privateOutputPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      publicOutputPath,
      `${JSON.stringify(
        {
          version: 1,
          id: evaluationId,
          generatedAt: new Date().toISOString(),
          blinded: true,
          candidateSource: `Direct production top ${candidateLimit}, reranked by each image model`,
          queries: publicQueries,
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(
      privateOutputPath,
      `${JSON.stringify(
        {
          version: 1,
          id: evaluationId,
          generatedAt: new Date().toISOString(),
          queries: privateQueries,
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
  ]);

  const seconds = (performance.now() - imageStartedAt) / 1000;
  console.log(
    `Prepared ${queries.length} blinded queries with ${assetIds.length} pooled candidates.`,
  );
  console.log(
    `Embedded ${pendingIds.length} new Jina images in ${seconds.toFixed(1)}s.`,
  );
  console.log(`Evaluator data: ${publicOutputPath}`);
  console.log(`Private ranking key: ${privateOutputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
