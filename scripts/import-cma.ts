import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CMA_ALLOWED_DEPARTMENTS,
  isCmaPainting,
  mapCmaArtwork,
  type CmaArtwork,
} from "../src/lib/catalog/cma";

const API_URL = "https://openaccess-api.clevelandart.org/api/artworks/";
const PAGE_SIZE = 100;
const REQUEST_DELAY_MS = 250;
const MAX_RETRIES = 4;
const FIELDS = [
  "id",
  "accession_number",
  "share_license_status",
  "title",
  "creation_date",
  "creation_date_earliest",
  "creation_date_latest",
  "culture",
  "technique",
  "department",
  "collection",
  "type",
  "description",
  "url",
  "images",
  "creators",
].join(",");

interface CmaResponse {
  info?: { total?: number };
  data?: CmaArtwork[];
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

async function fetchPage(department: string, skip: number) {
  const query = new URLSearchParams({
    type: "Painting",
    has_image: "1",
    cc0: "1",
    department,
    limit: String(PAGE_SIZE),
    skip: String(skip),
    fields: FIELDS,
  });
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(`${API_URL}?${query}`);
      if (!response.ok) {
        throw new Error(`CMA API returned HTTP ${response.status}.`);
      }
      return (await response.json()) as CmaResponse;
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES - 1) break;
      await sleep(REQUEST_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("CMA API request failed.");
}

async function main() {
  const output = argument("--output");
  if (!output) {
    throw new Error(
      "Pass an output path: npm run catalog:cma -- --output curation/cma.json",
    );
  }
  const requestedLimit = Number(argument("--limit") ?? 0);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 0) {
    throw new Error("--limit must be a non-negative integer.");
  }

  const entries = [];
  const seen = new Set<number>();
  for (const department of CMA_ALLOWED_DEPARTMENTS) {
    let skip = 0;
    let total = 1;
    while (skip < total) {
      const response = await fetchPage(department, skip);
      total = response.info?.total ?? 0;
      for (const candidate of response.data ?? []) {
        if (!isCmaPainting(candidate) || seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        const asset = mapCmaArtwork(candidate);
        entries.push({
          id: asset.id,
          source_path: `cma/${candidate.id}.jpg`,
          decision: "include" as const,
          exclusion_reason: null,
          metadata_status: "complete" as const,
          license_review_status: "approved" as const,
          asset,
        });
        if (requestedLimit && entries.length >= requestedLimit) break;
      }
      console.log(
        `[CMA] ${department}: ${Math.min(skip + PAGE_SIZE, total)}/${total}; ` +
          `${entries.length} paintings accepted`,
      );
      if (requestedLimit && entries.length >= requestedLimit) break;
      skip += PAGE_SIZE;
      if (skip < total) await sleep(REQUEST_DELAY_MS);
    }
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
  console.log(`Wrote ${entries.length} CMA paintings to ${outputPath}.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
