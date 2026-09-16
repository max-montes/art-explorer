export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(documents: string[]): Promise<number[][]>;
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

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions = 384;
  private extractor?: Promise<
    (
      input: string[],
      options: { pooling: "mean"; normalize: true },
    ) => Promise<unknown>
  >;

  constructor(
    private readonly model = "Xenova/all-MiniLM-L6-v2",
  ) {
    this.name = `transformers:${model}`;
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

  private async createExtractor() {
    const { pipeline } = await import("@huggingface/transformers");
    const extractor = await pipeline("feature-extraction", this.model);
    return async (
      input: string[],
      options: { pooling: "mean"; normalize: true },
    ): Promise<unknown> => extractor(input, options);
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
