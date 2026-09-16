/**
 * Browser-safe heuristics for creator names. Kept separate from the Commons
 * identifier, which depends on Node crypto and must stay server-only.
 */

/**
 * Free-text credits that should be checked by hand before approval: initials
 * ("E. Debat-Ponsan"), upload credits ("Gary Todd from Xinzheng, China"),
 * and institutional or anonymous attributions. Advisory only.
 */
export const creatorNeedsReview = (creator: string) => {
  const name = creator.trim();
  if (!name) return false;
  return (
    /\b[A-Z]\.\s*\S/.test(name) || // initials
    /\b(?:from|via|courtesy|scan(?:ned)? by|photo(?:graph)? by|uploaded? by)\b/i.test(name) ||
    /\b(?:unknown|anonymous|attributed|workshop|school of|after|follower|circle of)\b/i.test(name) ||
    /(?:museum|gallery|library|archive|collection|institute|foundation)/i.test(name)
  );
};
