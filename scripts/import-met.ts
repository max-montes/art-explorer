import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isPaintingOrSculptureObject,
  mapMetObject,
  MetObjectNotFoundError,
  isMetObject,
  normalizeMetQueries,
  mergeMetObjectIDs,
  capMetObjectIDs,
  type MetObject,
} from "../src/lib/catalog/met";

const API_ROOT = "https://collectionapi.metmuseum.org/public/collection/v1";
const REQUEST_DELAY_MS = 200;
const MAX_RETRIES = 3;
const OBJECT_CONCURRENCY = 4;

interface SearchResponse {
  objectIDs?: unknown;
}

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repeatedArgument = (name: string) =>
  process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] ? [process.argv[index + 1]] : [],
  );

const outputPath = argument("--output");
const queries = normalizeMetQueries(repeatedArgument("--query"));
const limitValue = argument("--limit");
const limit = limitValue === undefined ? 25 : Number(limitValue);
const candidateCapValue = argument("--candidate-cap");

if (!outputPath) {
  throw new Error(
    "Pass an output path: npm run catalog:met -- --output curation/met.json [--limit 25]",
  );
}
const requiredOutputPath = outputPath;
if (!Number.isInteger(limit) || limit < 1) {
  throw new Error("--limit must be a positive integer.");
}
const candidateCap =
  candidateCapValue === undefined
    ? Math.max(100, limit * 10)
    : Number(candidateCapValue);
if (!Number.isInteger(candidateCap) || candidateCap < 1) {
  throw new Error("--candidate-cap must be a positive integer.");
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchJson<T>(url: string, objectID?: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status === 404 && objectID !== undefined) {
        throw new MetObjectNotFoundError(objectID);
      }
      if (!response.ok) {
        throw new Error(`Met API returned HTTP ${response.status} for ${url}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof MetObjectNotFoundError) {
        throw error;
      }
      lastError = error;
      if (attempt === MAX_RETRIES - 1) break;
      await sleep(REQUEST_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Met API request failed.");
}

async function main() {
  const searchIDGroups: unknown[] = [];
  for (const query of queries) {
    const search = await fetchJson<SearchResponse>(
      `${API_ROOT}/search?hasImages=true&isPublicDomain=true&q=${encodeURIComponent(query)}`,
    );
    searchIDGroups.push(search.objectIDs);
  }
  const allCandidateIds = mergeMetObjectIDs(searchIDGroups);
  const candidateIds = capMetObjectIDs(allCandidateIds, candidateCap);
  const entries: unknown[] = [];
  let skippedNotFound = 0;
  let skippedInvalid = 0;
  let processed = 0;
  let rejected = 0;
  let nextIndex = 0;
  const processCandidate = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= candidateIds.length || entries.length >= limit) return;
      const objectID = candidateIds[index];
      let object: MetObject;
      try {
        object = await fetchJson<MetObject>(
          `${API_ROOT}/objects/${objectID}`,
          objectID,
        );
      } catch (error) {
        if (error instanceof MetObjectNotFoundError) {
          skippedNotFound += 1;
          processed += 1;
          console.log(
            `[Met] ${processed}/${candidateIds.length}: ${objectID} retired`,
          );
          await sleep(REQUEST_DELAY_MS);
          continue;
        }
        throw error;
      }
      processed += 1;
      if (!isMetObject(object)) {
        skippedInvalid += 1;
      } else if (isPaintingOrSculptureObject(object) && entries.length < limit) {
        const asset = mapMetObject(object);
        entries.push({
          id: asset.id,
          source_path: `met/${object.objectID}.jpg`,
          decision: "include" as const,
          exclusion_reason: null,
          metadata_status: "complete" as const,
          license_review_status: "approved" as const,
          asset,
        });
      } else {
        rejected += 1;
      }
      if (processed === 1 || processed % 10 === 0 || entries.length >= limit) {
        console.log(
          `[Met] ${processed}/${candidateIds.length} candidates; ` +
            `${entries.length} accepted, ${rejected} filtered, ` +
            `${skippedNotFound} retired, ${skippedInvalid} malformed`,
        );
      }
      await sleep(REQUEST_DELAY_MS);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(OBJECT_CONCURRENCY, candidateIds.length) },
      processCandidate,
    ),
  );

  const resolvedOutput = path.resolve(requiredOutputPath);
  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  await writeFile(
    resolvedOutput,
    `${JSON.stringify(
      {
        version: 1,
        source_root: path.dirname(resolvedOutput),
        entries,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(
    `Wrote ${entries.length} Met artwork entries to ${resolvedOutput} ` +
      `(queries: ${queries.join(", ")}, candidates: ${candidateIds.length}/` +
      `${allCandidateIds.length}, accepted: ${entries.length}, filtered: ` +
      `${rejected}, retired: ${skippedNotFound}, malformed: ${skippedInvalid}).`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
