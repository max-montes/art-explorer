import {
  TransformersEmbeddingProvider,
  type EmbeddingProvider,
} from "./providers";

const ART_MOVEMENTS = new Set([
  "gothic",
  "romanesque",
  "byzantine",
  "medieval",
  "renaissance",
  "mannerism",
  "baroque",
  "rococo",
  "neoclassicism",
  "neo-classicism",
  "romanticism",
  "realism",
  "naturalism",
  "impressionism",
  "post-impressionism",
  "pointillism",
  "divisionism",
  "luminism",
  "tonalism",
  "symbolism",
  "pre-raphaelite",
  "art nouveau",
  "art deco",
  "fauvism",
  "expressionism",
  "cubism",
  "futurism",
  "dadaism",
  "dada",
  "surrealism",
  "constructivism",
  "suprematism",
  "bauhaus",
  "precisionism",
  "abstract expressionism",
  "pop art",
  "op art",
  "minimalism",
  "conceptual art",
  "photorealism",
  "hyperrealism",
  "neo-expressionism",
  "postmodernism",
  "street art",
  "ukiyo-e",
  "japonisme",
  "orientalism",
  "harlem renaissance",
  "socialist realism",
  "magic realism",
]);

const NON_STYLE_ESQUE = new Set([
  "burlesque",
  "grotesque",
  "picturesque",
  "romanesque",
  "statuesque",
]);

export const isArtHistoricalQuery = (query: string) => {
  const normalized = query.toLocaleLowerCase();
  if (
    [...ART_MOVEMENTS].some((movement) =>
      new RegExp(`\\b${movement.replace("-", "\\-")}\\b`, "i").test(
        normalized,
      ),
    )
  ) {
    return true;
  }
  if (normalized.includes("in the style of")) return true;
  for (const match of normalized.matchAll(/\b([\p{L}-]+)ist\b/gu)) {
    if (ART_MOVEMENTS.has(`${match[1]}ism`)) return true;
  }
  if (/\b[\p{L}-]+istic\b/u.test(normalized)) return true;
  return [...normalized.matchAll(/\b[\p{L}-]+esque\b/gu)].some(
    ([word]) => !NON_STYLE_ESQUE.has(word),
  );
};

export type QueryProviderSelector = (query: string) => EmbeddingProvider;

export const createQueryProviderSelector = (
  generalProvider: EmbeddingProvider,
): QueryProviderSelector => {
  const styleProvider = new TransformersEmbeddingProvider(
    process.env.STYLE_EMBEDDING_MODEL ??
      "Xenova/siglip-base-patch16-224",
  );
  if (styleProvider.imageSpace !== "siglip") {
    throw new Error(
      "STYLE_EMBEDDING_MODEL must use the stored SigLIP vector space.",
    );
  }
  return (query) => {
    if (!isArtHistoricalQuery(query)) return generalProvider;
    return styleProvider;
  };
};
