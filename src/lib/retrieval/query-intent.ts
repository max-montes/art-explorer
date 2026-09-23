import { assetAssociations, type MediaAsset } from "@/lib/catalog/types";

const UNHELPFUL_CREATOR =
  /\b(?:unknown|unidentified|painter|artists?|family|workshop|school|master of|attributed|follower|circle|style of|copy)\b/i;
const FILLER_WORDS = new Set([
  "art",
  "artwork",
  "artworks",
  "by",
  "from",
  "of",
  "painting",
  "paintings",
  "the",
  "work",
  "works",
]);
const CULTURE_DEMONYMS: Record<string, string> = {
  chinese: "china",
  indian: "india",
  japanese: "japan",
  korean: "korea",
  nepalese: "nepal",
  nepali: "nepal",
  thai: "thailand",
  tibetan: "tibet",
};
const MEDIUM_ALIASES = ["oil on canvas", "watercolor", "watercolour", "tempera"];

export const normalizeCatalogText = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");

const containsPhrase = (text: string, phrase: string) =>
  ` ${text} `.includes(` ${phrase} `);

interface CreatorAlias {
  alias: string;
  creators: string[];
}

interface OriginAlias {
  alias: string;
  cultures: string[];
  artistNationalities: string[];
}

export interface CatalogLexicon {
  assets: MediaAsset[];
  creatorAliases: CreatorAlias[];
  originAliases: OriginAlias[];
  mediumAliases: string[];
  titles: Map<string, string[]>;
}

export interface CatalogQueryIntent {
  creatorNames: string[];
  titleAssetIds: string[];
  matchedCreatorAliases: string[];
  cultures: string[];
  artistNationalities: string[];
  mediumTerms: string[];
  yearRange?: { start: number; end: number };
  residualQuery: string;
}

const creatorPhrases = (creator: string) => {
  if (UNHELPFUL_CREATOR.test(creator)) return [];
  const parenthetical = [...creator.matchAll(/\(([^)]+)\)/g)].map(
    (match) => match[1],
  );
  const canonical = creator.replace(/\s*\([^)]*\)/g, "").trim();
  const phrases = [canonical, ...parenthetical]
    .map(normalizeCatalogText)
    .filter(Boolean);
  const canonicalTokens = normalizeCatalogText(canonical).split(" ");
  if (canonicalTokens.length > 1) {
    const surname = canonicalTokens.at(-1);
    if (surname && surname.length >= 4) phrases.push(surname);
  }
  return [...new Set(phrases)];
};

export const buildCatalogLexicon = (assets: MediaAsset[]): CatalogLexicon => {
  const aliases = new Map<string, Set<string>>();
  const cultureAliases = new Map<string, Set<string>>();
  const nationalityAliases = new Map<string, Set<string>>();
  const mediumAliases = new Set<string>();
  const titles = new Map<string, string[]>();
  for (const asset of assets) {
    for (const alias of creatorPhrases(asset.creator)) {
      const creators = aliases.get(alias) ?? new Set<string>();
      creators.add(asset.creator);
      aliases.set(alias, creators);
    }
    const title = normalizeCatalogText(asset.title);
    if (title) titles.set(title, [...(titles.get(title) ?? []), asset.id]);
    if (asset.culture) {
      const full = normalizeCatalogText(asset.culture);
      const base = normalizeCatalogText(asset.culture.split(/[,(]/, 1)[0]);
      for (const alias of new Set([full, base])) {
        if (!alias) continue;
        const cultures = cultureAliases.get(alias) ?? new Set<string>();
        cultures.add(asset.culture);
        cultureAliases.set(alias, cultures);
      }
    }
    if (asset.artistNationality) {
      const full = normalizeCatalogText(asset.artistNationality);
      const base = normalizeCatalogText(
        asset.artistNationality.split(/[,(]/, 1)[0],
      );
      for (const alias of new Set([full, base])) {
        if (!alias) continue;
        const nationalities = nationalityAliases.get(alias) ?? new Set<string>();
        nationalities.add(asset.artistNationality);
        nationalityAliases.set(alias, nationalities);
      }
    }
    const medium = normalizeCatalogText(asset.medium ?? "");
    for (const alias of MEDIUM_ALIASES) {
      if (containsPhrase(medium, alias)) mediumAliases.add(alias);
    }
  }
  for (const [demonym, country] of Object.entries(CULTURE_DEMONYMS)) {
    const matching = [...cultureAliases]
      .filter(([alias]) => alias === country)
      .flatMap(([, cultures]) => [...cultures]);
    if (matching.length) cultureAliases.set(demonym, new Set(matching));
  }
  const originAliases = new Set([
    ...cultureAliases.keys(),
    ...nationalityAliases.keys(),
  ]);
  return {
    assets,
    creatorAliases: [...aliases].map(([alias, creators]) => ({
      alias,
      creators: [...creators],
    })),
    originAliases: [...originAliases].map((alias) => ({
      alias,
      cultures: [...(cultureAliases.get(alias) ?? [])],
      artistNationalities: [...(nationalityAliases.get(alias) ?? [])],
    })),
    mediumAliases: [...mediumAliases],
    titles,
  };
};

const outsideMentions = (
  lexicon: CatalogLexicon,
  alias: CreatorAlias,
) => {
  const creators = new Set(alias.creators);
  return lexicon.assets.filter(
    (asset) =>
      !creators.has(asset.creator) &&
      (containsPhrase(normalizeCatalogText(asset.title), alias.alias) ||
        assetAssociations(asset).some((label) =>
          containsPhrase(normalizeCatalogText(label), alias.alias),
        )),
  ).length;
};

export const analyzeCatalogQuery = (
  query: string,
  lexicon: CatalogLexicon,
): CatalogQueryIntent => {
  const normalized = normalizeCatalogText(query);
  const titleAssetIds = lexicon.titles.get(normalized) ?? [];
  const titleIsDistinctive =
    titleAssetIds.length > 0 &&
    (normalized.split(" ").length > 1 || titleAssetIds.length === 1);
  const originMatch = titleIsDistinctive
    ? undefined
    : lexicon.originAliases
        .filter(({ alias }) => containsPhrase(normalized, alias))
        .sort(
          (left, right) =>
            right.alias.split(" ").length - left.alias.split(" ").length,
        )[0];
  const mediumMatch = titleIsDistinctive
    ? undefined
    : lexicon.mediumAliases
        .filter((alias) => containsPhrase(normalized, alias))
        .sort(
          (left, right) =>
            right.split(" ").length - left.split(" ").length,
        )[0];
  const centuryMatch = normalized.match(
    /\b(\d{1,2})(?:st|nd|rd|th) century\b/,
  );
  const century = centuryMatch ? Number(centuryMatch[1]) : undefined;
  const yearRange = century
    ? { start: (century - 1) * 100, end: century * 100 - 1 }
    : undefined;

  // An exact distinctive title is stronger evidence than a name-like token
  // within that title, so do not infer a creator from the same words.
  const candidates = titleIsDistinctive
    ? []
    : lexicon.creatorAliases
        .filter(({ alias }) => containsPhrase(normalized, alias))
        .filter(
          (entry) =>
            entry.alias.split(" ").length > 1 ||
            outsideMentions(lexicon, entry) <= 2,
        )
        .sort(
          (left, right) =>
            right.alias.split(" ").length - left.alias.split(" ").length,
        );

  const selected: CreatorAlias[] = [];
  for (const candidate of candidates) {
    if (
      selected.some((entry) =>
        containsPhrase(entry.alias, candidate.alias),
      )
    ) {
      continue;
    }
    selected.push(candidate);
  }

  let residual = normalized;
  for (const { alias } of selected) {
    residual = ` ${residual} `.replace(` ${alias} `, " ").trim();
  }
  if (originMatch) {
    residual = ` ${residual} `
      .replace(` ${originMatch.alias} `, " ")
      .trim();
  }
  if (mediumMatch) {
    residual = ` ${residual} `.replace(` ${mediumMatch} `, " ").trim();
  }
  if (centuryMatch) {
    residual = ` ${residual} `
      .replace(` ${centuryMatch[0]} `, " ")
      .trim();
  }
  residual = residual
    .split(" ")
    .filter((word) => word && !FILLER_WORDS.has(word))
    .join(" ");

  return {
    creatorNames: [...new Set(selected.flatMap(({ creators }) => creators))],
    titleAssetIds: titleIsDistinctive ? titleAssetIds : [],
    matchedCreatorAliases: selected.map(({ alias }) => alias),
    cultures: originMatch?.cultures ?? [],
    artistNationalities: originMatch?.artistNationalities ?? [],
    mediumTerms: mediumMatch ? [mediumMatch] : [],
    ...(yearRange ? { yearRange } : {}),
    residualQuery: residual,
  };
};
