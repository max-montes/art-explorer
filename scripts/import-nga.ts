import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse";
import {
  isNgaPainting,
  mapNgaPainting,
  type NgaImage,
  type NgaObject,
} from "../src/lib/catalog/nga";

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

async function rows<T>(filePath: string): Promise<T[]> {
  const records: T[] = [];
  const parser = createReadStream(filePath).pipe(
    parse({
      columns: true,
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
    }),
  );
  for await (const record of parser) records.push(record as T);
  return records;
}

async function main() {
  const output = argument("--output");
  if (!output) {
    throw new Error(
      "Pass --output and optionally --objects/--images CSV paths.",
    );
  }
  const objectsPath = path.resolve(
    argument("--objects") ?? ".cache/catalog/nga/objects.csv",
  );
  const imagesPath = path.resolve(
    argument("--images") ?? ".cache/catalog/nga/published_images.csv",
  );
  const requestedLimit = Number(argument("--limit") ?? 0);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 0) {
    throw new Error("--limit must be a non-negative integer.");
  }

  const images = new Map<string, NgaImage>();
  for (const image of await rows<NgaImage>(imagesPath)) {
    if (
      image.openaccess !== "1" ||
      image.viewtype !== "primary" ||
      !image.depictstmsobjectid
    ) {
      continue;
    }
    const current = images.get(image.depictstmsobjectid);
    if (
      !current ||
      Number(image.sequence || 0) < Number(current.sequence || 0)
    ) {
      images.set(image.depictstmsobjectid, image);
    }
  }

  const entries = [];
  for (const object of await rows<NgaObject>(objectsPath)) {
    const image = images.get(object.objectid);
    if (!isNgaPainting(object, image) || !image) continue;
    const asset = mapNgaPainting(object, image);
    entries.push({
      id: asset.id,
      source_path: `nga/${object.objectid}.jpg`,
      decision: "include" as const,
      exclusion_reason: null,
      metadata_status: "complete" as const,
      license_review_status: "approved" as const,
      asset,
    });
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
  console.log(`Wrote ${entries.length} NGA paintings to ${outputPath}.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
