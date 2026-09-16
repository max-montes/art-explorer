import {
  assetAssociations,
  type AssetVectors,
  type MediaAsset,
  type SearchWeights,
} from "@/lib/catalog/types";

export const cosine = (left: number[], right: number[]) => {
  if (left.length !== right.length) {
    throw new Error("Cannot compare vectors with different dimensions.");
  }
  return left.reduce(
    (sum, component, index) => sum + component * right[index],
    0,
  );
};

/**
 * How much other well-matching labels add on top of the best one. Relative
 * to the best match rather than an absolute floor: MiniLM puts "related" at
 * roughly 0.35–0.55, so a second label within 70% of the best is real
 * evidence the work is about the query (Rejected Poet: Love + Rejection for
 * "heartbreak") rather than touching it once. Capped so breadth never beats
 * a stronger single match by much.
 */
const SECONDARY_RELATIVE_FLOOR = 0.7;
const SECONDARY_MATCH_WEIGHT = 0.6;
const SECONDARY_MAX_BONUS = 0.08;

export interface SemanticScore {
  semantic: number;
  matchedLabel?: string;
}

/**
 * Score an asset's associations against a query vector. With per-label
 * vectors, the best label carries the score and any other strong labels add a
 * little; this keeps a literal match from being averaged away by the rest of
 * the list. Without them (records embedded before labels existed), fall back
 * to the whole-list vector.
 */
export const semanticScore = (
  queryVector: number[],
  asset: MediaAsset,
  vectors: AssetVectors,
  mode: "labels" | "whole",
): SemanticScore => {
  if (mode === "whole" || !vectors.labels || vectors.labels.length === 0) {
    return { semantic: cosine(queryVector, vectors.semantic) };
  }
  const labels = assetAssociations(asset);
  const similarities = vectors.labels.map((vector) => cosine(queryVector, vector));
  let bestIndex = 0;
  similarities.forEach((s, i) => {
    if (s > similarities[bestIndex]) bestIndex = i;
  });
  const best = similarities[bestIndex];
  const floor = best * SECONDARY_RELATIVE_FLOOR;
  let secondary = 0;
  similarities.forEach((s, i) => {
    if (i !== bestIndex && s > floor) secondary += s - floor;
  });
  const bonus = Math.min(SECONDARY_MAX_BONUS, secondary * SECONDARY_MATCH_WEIGHT);
  return {
    semantic: Math.min(1, best + bonus),
    matchedLabel: labels[bestIndex],
  };
};

export const combinedScore = (
  scores: SearchWeights,
  weights: SearchWeights,
) =>
  scores.semantic * weights.semantic +
  scores.metadata * weights.metadata +
  (scores.image ?? 0) * (weights.image ?? 0);
