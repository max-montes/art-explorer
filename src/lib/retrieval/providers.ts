export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(documents: string[]): Promise<number[][]>;
}

export interface ImageEmbeddingProvider {
  readonly imageDimensions: number;
  embedImages(images: string[]): Promise<number[][]>;
  embedImageText(texts: string[]): Promise<number[][]>;
}

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

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly name = "deterministic-semantic-hash";
  readonly dimensions = 384;

  async embed(documents: string[]): Promise<number[][]> {
    return documents.map((document) => {
      const vector = Array.from({ length: this.dimensions }, () => 0);
      for (const token of tokenize(document)) {
        const tokenHash = hash(token);
        const bucket = tokenHash % this.dimensions;
        const sign = tokenHash & 1 ? 1 : -1;
        vector[bucket] += sign;
      }
      return normalize(vector);
    });
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
  readonly dimensions = 384;
  readonly imageDimensions: number;
  private readonly imageModel: string;
  private extractor?: Promise<
    (
      input: string[],
      options: { pooling: "mean"; normalize: true },
    ) => Promise<unknown>
  >;
  private imageExtractor?: Promise<(input: string | string[]) => Promise<unknown>>;
  private imageText?: Promise<{
    tokenizer: (input: string[]) => Promise<Record<string, unknown>>;
    model: (input: Record<string, unknown>) => Promise<unknown>;
  }>;

  constructor(
    private readonly model = "Xenova/all-MiniLM-L6-v2",
  ) {
    this.imageModel =
      process.env.IMAGE_EMBEDDING_MODEL ??
      "Xenova/siglip-base-patch16-224";
    this.imageDimensions = /siglip/i.test(this.imageModel) ? 768 : 512;
    this.name = `transformers:${model}+${this.imageModel}`;
  }

  async embed(documents: string[]): Promise<number[][]> {
    if (!this.extractor) {
      this.extractor = this.createExtractor();
    }

    const extractor = await this.extractor;
    const output = await extractor(documents, {
      pooling: "mean",
      normalize: true,
    });
    const values = isTensorLike(output) ? output.tolist() : output;

    if (!isNumberMatrix(values)) {
      throw new Error(`Embedding model ${this.model} returned an invalid tensor.`);
    }
    return values;
  }

  async embedImages(images: string[]): Promise<number[][]> {
    if (!this.imageExtractor) this.imageExtractor = this.createImageExtractor();
    const output = await (await this.imageExtractor)(images);
    return this.tensorRows(output, "image").map(normalize);
  }

  async embedImageText(texts: string[]): Promise<number[][]> {
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

  private async createExtractor() {
    const { pipeline } = await import("@huggingface/transformers");
    const extractor = await pipeline("feature-extraction", this.model, {
      session_options: onnxSessionOptions(),
    });
    return async (
      input: string[],
      options: { pooling: "mean"; normalize: true },
    ): Promise<unknown> => extractor(input, options);
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

  private tensorRows(value: unknown, kind: string): number[][] {
    const values = isTensorLike(value) ? value.tolist() : value;
    if (!isNumberMatrix(values)) {
      throw new Error(`Image-text ${kind} model returned an invalid tensor.`);
    }
    return values;
  }
}

export function createEmbeddingProvider(): EmbeddingProvider {
  const provider = process.env.EMBEDDING_PROVIDER ?? "transformers";
  if (provider === "deterministic") {
    return new DeterministicEmbeddingProvider();
  }
  if (provider === "transformers") {
    return new TransformersEmbeddingProvider(process.env.EMBEDDING_MODEL);
  }
  throw new Error(`Unsupported EMBEDDING_PROVIDER: ${provider}`);
}
