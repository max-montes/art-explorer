import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AIC_ALLOWED_DEPARTMENTS,
  isAicPainting,
  mapAicArtwork,
  type AicArtwork,
} from "../src/lib/catalog/aic";

const API_URL = "https://api.artic.edu/api/v1/artworks/search";
const REQUEST_DELAY_MS = 1_000;
const PAGE_SIZE = 100;
const MAX_RETRIES = 4;
const FIELDS = [
  "id",
  "title",
  "artist_title",
  "artist_display",
  "date_display",
  "date_start",
  "date_end",
  "main_reference_number",
  "image_id",
  "is_public_domain",
  "artwork_type_title",
  "classification_title",
  "department_title",
  "place_of_origin",
  "medium_display",
  "thumbnail",
].join(",");

interface AicResponse {
  pagination?: {
    total?: number;
    total_pages?: number;
    current_page?: number;
  };
  data?: AicArtwork[];
  config?: { iiif_url?: string };
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

async function fetchPage(
  page: number,
  department: (typeof AIC_ALLOWED_DEPARTMENTS)[number],
): Promise<AicResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(
        `${API_URL}?limit=${PAGE_SIZE}&page=${page}&fields=${FIELDS}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: {
              bool: {
                filter: [
                  { term: { is_public_domain: true } },
                  { term: { "artwork_type_title.keyword": "Painting" } },
                  {
                    term: {
                      "department_title.keyword": department,
                    },
                  },
                  { exists: { field: "image_id" } },
                ],
              },
            },
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`AIC API returned HTTP ${response.status}.`);
      }
      return (await response.json()) as AicResponse;
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES - 1) break;
      await sleep(REQUEST_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("AIC API request failed.");
}

async function main() {
  const output = argument("--output");
  if (!output) {
    throw new Error(
      "Pass an output path: npm run catalog:aic -- --output curation/aic.json",
    );
  }
  const requestedLimit = Number(argument("--limit") ?? 0);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 0) {
    throw new Error("--limit must be a non-negative integer.");
  }

  const entries = [];
  const seen = new Set<number>();
  let iiifUrl = "https://www.artic.edu/iiif/2";
  for (const department of AIC_ALLOWED_DEPARTMENTS) {
    let page = 1;
    let totalPages = 1;
    do {
      const response = await fetchPage(page, department);
      totalPages = response.pagination?.total_pages ?? page;
      iiifUrl = response.config?.iiif_url ?? iiifUrl;
      for (const candidate of response.data ?? []) {
        if (!isAicPainting(candidate) || seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        const asset = mapAicArtwork(candidate, iiifUrl);
        entries.push({
          id: asset.id,
          source_path: `aic/${candidate.id}.jpg`,
          decision: "include" as const,
          exclusion_reason: null,
          metadata_status: "complete" as const,
          license_review_status: "approved" as const,
          asset,
        });
        if (requestedLimit && entries.length >= requestedLimit) break;
      }
      console.log(
        `[AIC] ${department}: page ${page}/${totalPages}; ` +
          `${entries.length} paintings accepted`,
      );
      if (requestedLimit && entries.length >= requestedLimit) break;
      page += 1;
      if (page <= totalPages) await sleep(REQUEST_DELAY_MS);
    } while (page <= totalPages);
    if (requestedLimit && entries.length >= requestedLimit) break;
  }

  const outputPath = path.resolve(output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        version: 1,
        source_root: path.dirname(outputPath),
        entries,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Wrote ${entries.length} AIC paintings to ${outputPath}.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
