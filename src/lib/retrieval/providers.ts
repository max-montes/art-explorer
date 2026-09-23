export interface EmbeddingProvider {
  readonly name: string;
  readonly imageDimensions: number;
  embedImages(images: string[]): Promise<number[][]>;
  embedImageText(texts: string[]): Promise<number[][]>;
}
export type ImageEmbeddingProvider = EmbeddingProvider;

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
  readonly name = "deterministic-image-hash";
  readonly imageDimensions = 384;

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

  constructor() {
    this.imageModel =
      process.env.IMAGE_EMBEDDING_MODEL ??
      "jinaai/jina-clip-v2";
    this.imageDimensions = /jina-clip-v2/i.test(this.imageModel)
      ? 256
      : /siglip/i.test(this.imageModel)
        ? 768
        : 512;
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
          await processor(input, null, {
            padding: true,
            truncation: true,
          }),
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

export function createEmbeddingProvider(): EmbeddingProvider {
  const provider = process.env.EMBEDDING_PROVIDER ?? "transformers";
  if (provider === "deterministic") {
    return new DeterministicEmbeddingProvider();
  }
  if (provider === "transformers") {
    return new TransformersEmbeddingProvider();
  }
  throw new Error(`Unsupported EMBEDDING_PROVIDER: ${provider}`);
}
