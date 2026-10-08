export interface EmbeddingProvider {
  readonly name: string;
  readonly imageDimensions: number;
  readonly imageSpace: ImageEmbeddingSpace;
  embedImages(images: string[]): Promise<number[][]>;
  embedImageText(texts: string[]): Promise<number[][]>;
}
export type ImageEmbeddingProvider = EmbeddingProvider;
export type ImageEmbeddingSpace =
  | "deterministic"
  | "siglip"
  | "jina-local"
  | "jina-hosted";

const SEMANTIC_EXPANSIONS: Record<string, string[]> = {
  plato: ["classical philosophy", "reason", "philosopher"],
  aristotle: ["classical philosophy", "reason", "philosopher"],
  philosophy: ["reason", "inquiry", "wisdom"],
  "societal decay": ["civilizational collapse", "destruction", "ruin", "empire"],
  decadence: ["societal decay", "decline", "collapse"],
  melancholy: ["melancholic", "somber", "inner turmoil"],
  solitude: ["isolation", "contemplative", "loneliness"],
  revolution: ["uprising", "liberty", "renewal"],
  awe: ["the sublime", "vastness", "wonder"],
};

const tokenize = (text: string) => {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const expanded = Object.entries(SEMANTIC_EXPANSIONS)
    .filter(([phrase]) => normalized.includes(phrase))
    .flatMap(([, terms]) => terms);

  return `${normalized} ${expanded.join(" ")}`
    .split(/\s+/)
    .filter((token) => token.length > 2);
};

const hash = (token: string) => {
  let value = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    value ^= token.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
};

const normalize = (vector: number[]) => {
  const magnitude = Math.sqrt(
    vector.reduce((sum, component) => sum + component * component, 0),
  );
  return magnitude === 0
    ? vector
    : vector.map((component) => component / magnitude);
};

export const JINA_RETRIEVAL_QUERY_PREFIX =
  "Represent the query for retrieving evidence documents: ";
export const jinaRetrievalQueries = (texts: string[]) =>
  texts.map((text) => `${JINA_RETRIEVAL_QUERY_PREFIX}${text}`);

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly name = "deterministic-image-hash";
  readonly imageDimensions = 384;
  readonly imageSpace = "deterministic" as const;

  async embedImageText(documents: string[]): Promise<number[][]> {
    return documents.map((document) => {
      const vector = Array.from({ length: this.imageDimensions }, () => 0);
      for (const token of tokenize(document)) {
        const tokenHash = hash(token);
        const bucket = tokenHash % this.imageDimensions;
        const sign = tokenHash & 1 ? 1 : -1;
        vector[bucket] += sign;
      }
      return normalize(vector);
    });
  }

  embedImages(images: string[]): Promise<number[][]> {
    return this.embedImageText(images);
  }
}

type TensorLike = { tolist(): unknown };

const isTensorLike = (value: unknown): value is TensorLike =>
  typeof value === "object" &&
  value !== null &&
  "tolist" in value &&
  typeof value.tolist === "function";

const isNumberMatrix = (value: unknown): value is number[][] =>
  Array.isArray(value) &&
  value.every(
    (row) =>
      Array.isArray(row) &&
      row.every((component) => typeof component === "number"),
  );

const onnxThreadCount = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
};

const onnxSessionOptions = () => ({
  intraOpNumThreads: onnxThreadCount("ONNX_INTRA_OP_THREADS", 1),
  interOpNumThreads: onnxThreadCount("ONNX_INTER_OP_THREADS", 1),
  executionMode: "sequential" as const,
});

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly imageDimensions: number;
  readonly imageSpace: ImageEmbeddingSpace;
  private readonly imageModel: string;
  private imageExtractor?: Promise<(input: string | string[]) => Promise<unknown>>;
  private imageText?: Promise<{
    tokenizer: (input: string[]) => Promise<Record<string, unknown>>;
    model: (input: Record<string, unknown>) => Promise<unknown>;
  }>;
  private jina?: Promise<{
    embedImages: (input: string[]) => Promise<unknown>;
    embedText: (input: string[]) => Promise<unknown>;
  }>;

  constructor(
    imageModel = process.env.IMAGE_EMBEDDING_MODEL ?? "jinaai/jina-clip-v2",
    private readonly jinaRetrievalTask = true,
  ) {
    this.imageModel = imageModel;
    this.imageDimensions = /jina-clip-v2/i.test(this.imageModel)
      ? 256
      : /siglip/i.test(this.imageModel)
        ? 768
        : 512;
    this.imageSpace = /jina-clip-v2/i.test(this.imageModel)
      ? "jina-local"
      : /siglip/i.test(this.imageModel)
        ? "siglip"
        : "deterministic";
    this.name = `transformers:${this.imageModel}`;
  }

  async embedImages(images: string[]): Promise<number[][]> {
    if (/jina-clip-v2/i.test(this.imageModel)) {
      if (!this.jina) this.jina = this.createJina();
      const output = await (await this.jina).embedImages(images);
      return this.jinaRows(output, "image");
    }
    if (!this.imageExtractor) this.imageExtractor = this.createImageExtractor();
    const output = await (await this.imageExtractor)(images);
    return this.tensorRows(output, "image").map(normalize);
  }

  async embedImageText(texts: string[]): Promise<number[][]> {
    if (/jina-clip-v2/i.test(this.imageModel)) {
      if (!this.jina) this.jina = this.createJina();
      const output = await (await this.jina).embedText(texts);
      return this.jinaRows(output, "text");
    }
    if (!this.imageText) this.imageText = this.createImageText();
    const { tokenizer, model } = await this.imageText;
    const output = await model(await tokenizer(texts));
    const values =
      (output as { text_embeds?: unknown; pooler_output?: unknown })
        .text_embeds ??
      (output as { pooler_output?: unknown }).pooler_output ??
      output;
    return this.tensorRows(values, "text").map(normalize);
  }

  private async createImageExtractor() {
    const { pipeline } = await import("@huggingface/transformers");
    const extractor = await pipeline(
      "image-feature-extraction",
      this.imageModel,
      { session_options: onnxSessionOptions() },
    );
    return async (input: string | string[]) =>
      /siglip/i.test(this.imageModel)
        ? extractor(input, { pool: true })
        : extractor(input);
  }

  private async createImageText() {
    const transformers = await import("@huggingface/transformers");
    const tokenizer = await transformers.AutoTokenizer.from_pretrained(
      this.imageModel,
    );
    const model = /siglip/i.test(this.imageModel)
      ? await transformers.SiglipTextModel.from_pretrained(this.imageModel, {
          session_options: onnxSessionOptions(),
        })
      : await transformers.CLIPTextModelWithProjection.from_pretrained(
          this.imageModel,
          { session_options: onnxSessionOptions() },
        );
    return {
      tokenizer: async (input: string[]) =>
        tokenizer(input, { padding: "max_length", truncation: true }) as Record<
          string,
          unknown
        >,
      model: async (input: Record<string, unknown>) => model(input),
    };
  }

  private async createJina() {
    const transformers = await import("@huggingface/transformers");
    const [processor, model] = await Promise.all([
      transformers.AutoProcessor.from_pretrained(this.imageModel),
      transformers.AutoModel.from_pretrained(this.imageModel, {
        dtype: "q4",
        session_options: onnxSessionOptions(),
      }),
    ]);
    return {
      embedImages: async (input: string[]) => {
        const images = await Promise.all(
          input.map((image) => transformers.RawImage.read(image)),
        );
        return model(await processor(null, images));
      },
      embedText: async (input: string[]) =>
        model(
          await processor(
            this.jinaRetrievalTask ? jinaRetrievalQueries(input) : input,
            null,
            {
            padding: true,
            truncation: true,
            },
          ),
        ),
    };
  }

  private jinaRows(value: unknown, kind: string): number[][] {
    const output = value as {
      l2norm_image_embeddings?: unknown;
      l2norm_text_embeddings?: unknown;
    };
    const tensor =
      kind === "image"
        ? output.l2norm_image_embeddings
        : output.l2norm_text_embeddings;
    return this.tensorRows(tensor, kind).map((row) =>
      normalize(row.slice(0, this.imageDimensions)),
    );
  }

  private tensorRows(value: unknown, kind: string): number[][] {
    const values = isTensorLike(value) ? value.tolist() : value;
    if (!isNumberMatrix(values)) {
      throw new Error(`Image-text ${kind} model returned an invalid tensor.`);
    }
    return values;
  }
}

interface JinaApiEmbedding {
  index: number;
  embedding: number[];
}
type JinaApiInput = string | { image: string } | { text: string };

export class HostedJinaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "jina-api:jina-clip-v2";
  readonly imageDimensions = 256;
  readonly imageSpace = "jina-hosted" as const;
  private readonly endpoint =
    process.env.JINA_API_URL ?? "https://api.jina.ai/v1/embeddings";
  private readonly batchSize = onnxThreadCount("JINA_API_BATCH_SIZE", 16);

  constructor(private readonly apiKey = process.env.JINA_API_KEY) {
    if (!apiKey) {
      throw new Error(
        "JINA_API_KEY is required when EMBEDDING_PROVIDER=jina-api.",
      );
    }
  }

  embedImages(images: string[]): Promise<number[][]> {
    return this.embed(
      images.map((image) => ({
        image: image.replace(/^data:[^;]+;base64,/, ""),
      })),
    );
  }

  embedImageText(texts: string[]): Promise<number[][]> {
    return this.embed(
      texts.map((text) => ({ text })),
      "retrieval.query",
    );
  }

  private async embed(
    input: JinaApiInput[],
    task?: "retrieval.query",
  ): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let start = 0; start < input.length; start += this.batchSize) {
      const batch = input.slice(start, start + this.batchSize);
      const data = await this.request(batch, task);
      vectors.push(
        ...data
          .sort((left, right) => left.index - right.index)
          .map(({ embedding }) => normalize(embedding)),
      );
    }
    return vectors;
  }

  private async request(
    input: JinaApiInput[],
    task?: "retrieval.query",
  ): Promise<JinaApiEmbedding[]> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "jina-clip-v2",
          input,
          dimensions: this.imageDimensions,
          embedding_type: "float",
          normalized: true,
          truncate: true,
          ...(task ? { task } : {}),
        }),
      });
      if (response.ok) {
        const payload = (await response.json()) as {
          data?: JinaApiEmbedding[];
        };
        if (
          !Array.isArray(payload.data) ||
          payload.data.length !== input.length ||
          payload.data.some(
            ({ embedding }) =>
              !Array.isArray(embedding) ||
              embedding.length !== this.imageDimensions,
          )
        ) {
          throw new Error("Jina API returned an invalid embedding response.");
        }
        return payload.data;
      }
      const detail = await response.text();
      if (
        attempt === 3 ||
        (response.status !== 429 && response.status < 500)
      ) {
        throw new Error(
          `Jina API failed (${response.status}): ${detail.slice(0, 500)}`,
        );
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Number.isFinite(retryAfter)
            ? retryAfter * 1000
            : 1000 * 2 ** attempt,
        ),
      );
    }
    throw new Error("Jina API retry loop exited unexpectedly.");
  }
}

export function createEmbeddingProvider(): EmbeddingProvider {
  const provider = process.env.EMBEDDING_PROVIDER ?? "transformers";
  if (provider === "deterministic") {
    return new DeterministicEmbeddingProvider();
  }
  if (provider === "transformers") {
    return new TransformersEmbeddingProvider(
      undefined,
      (process.env.JINA_QUERY_TASK ?? "on") !== "off",
    );
  }
  if (provider === "jina-api") {
    return new HostedJinaEmbeddingProvider();
  }
  throw new Error(`Unsupported EMBEDDING_PROVIDER: ${provider}`);
}
