import type { MediaAsset } from "@/lib/catalog/types";

/**
 * Curated-shape fixtures: the exact record shape the curator workbench
 * produces (untyped associations, Commons provenance, local media URL).
 * These stand in for the user's real catalog so retrieval behaviour stays
 * measurable without bundling any artwork data in the app.
 */
export const curatedAsset = (
  id: string,
  title: string,
  creator: string,
  associations: string[],
  overrides: Partial<MediaAsset> = {},
): MediaAsset => ({
  id: `curated-${id}`,
  type: "artwork",
  libraryCategory: "artwork",
  title,
  creator,
  year: "Unknown",
  source: {
    provider: "Wikimedia Commons",
    sourceUrl: `https://commons.wikimedia.org/wiki/File:${id}.jpg`,
    mediaUrl: `/api/local-media/${id.padEnd(64, "0")}`,
    license: "Public domain",
  },
  semantics: {
    associations,
    concepts: [],
    moods: [],
    subjects: [],
    description: "",
    narrative: "",
  },
  ownerId: null,
  ...overrides,
});

export const curatedFixtures: MediaAsset[] = [
  curatedAsset("school-of-athens", "The School of Athens", "Raphael", [
    "Plato",
    "Aristotle",
    "Classical philosophy",
    "Reason",
    "Humanism",
    "Intellectual lineage",
  ]),
  curatedAsset(
    "course-of-empire-destruction",
    "The Course of Empire: Destruction",
    "Thomas Cole",
    [
      "Societal decay",
      "Civilizational collapse",
      "Empire",
      "Ruin",
      "Political violence",
      "Impermanence",
    ],
  ),
  curatedAsset(
    "wanderer-above-sea-of-fog",
    "Wanderer above the Sea of Fog",
    "Caspar David Friedrich",
    ["The sublime", "Isolation", "Awe", "Uncertainty", "Solitary traveler"],
  ),
  curatedAsset("starry-night", "The Starry Night", "Vincent van Gogh", [
    "Inner turmoil",
    "The sublime",
    "Isolation",
    "Melancholic",
    "Night sky",
  ]),
  curatedAsset(
    "apotheosis-of-hercules",
    "The Apotheosis of Hercules",
    "François Lemoyne",
    ["Divinity", "Hercules", "Gods", "Ascension", "Apotheosis"],
  ),
  // Artwork lives in its own channel and must never mix with artwork.
  curatedAsset(
    "prelinger-factory",
    "Factory Floor, 1946",
    "Prelinger Archives",
    ["Industrial history", "Factory workers", "Labor", "Machinery", "Isolation"],
    { type: "artwork", libraryCategory: "artwork" },
  ),
  // Artwork are recommended for a whole script by overall tone.
  curatedAsset(
    "moonlight-sonata",
    "Piano Sonata No. 14 (Moonlight)",
    "Ludwig van Beethoven",
    ["Grief", "Isolation", "Inner turmoil", "Melancholic", "Stillness"],
    { type: "artwork", libraryCategory: "artwork" },
  ),
  curatedAsset(
    "ode-to-joy",
    "Symphony No. 9, Ode to Joy",
    "Ludwig van Beethoven",
    ["Triumph", "Renewal", "Brotherhood", "Hopeful", "Celebration"],
    { type: "artwork", libraryCategory: "artwork" },
  ),
];
