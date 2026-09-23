import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import {
  approvedManifestEntries,
  parseCurationManifest,
} from "../src/lib/catalog/manifest";

const ALLOWED_DEPARTMENTS = new Set([
  "European Paintings",
  "The American Wing",
  "Robert Lehman Collection",
  "Modern and Contemporary Art",
]);

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    throw new Error(
      "Pass the filtered Met manifest: npm run catalog:prune -- <manifest>",
    );
  }
  if (!process.argv.includes("--apply")) {
    throw new Error("Pass --apply to confirm destructive catalog pruning.");
  }

  const manifest = parseCurationManifest(
    JSON.parse(await readFile(path.resolve(manifestPath), "utf8")),
  );
  const entries = approvedManifestEntries(manifest);
  const invalid = entries.find(
    ({ asset }) =>
      !asset.department || !ALLOWED_DEPARTMENTS.has(asset.department),
  );
  if (invalid) {
    throw new Error(
      `Manifest entry ${invalid.id} has an unsupported department: ${
        invalid.asset.department ?? "missing"
      }.`,
    );
  }

  const ids = entries.map(({ asset }) => asset.id);
  const departments = entries.map(({ asset }) => asset.department as string);
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "******localhost:5432/art_explorer",
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deleted = await client.query(
      `DELETE FROM media_assets
        WHERE source_provider = 'The Metropolitan Museum of Art'
          AND NOT (id = ANY($1::text[]))`,
      [ids],
    );
    await client.query(
      `UPDATE media_assets AS asset
          SET catalog_payload = jsonb_set(
            asset.catalog_payload,
            '{department}',
            to_jsonb(source.department)
          ),
              updated_at = now()
         FROM unnest($1::text[], $2::text[]) AS source(id, department)
        WHERE asset.id = source.id`,
      [ids, departments],
    );
    await client.query("COMMIT");
    console.log(
      `[Catalog] retained ${ids.length} approved Met paintings; removed ${deleted.rowCount ?? 0}.`,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
