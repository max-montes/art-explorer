import { Pool } from "pg";
import {
  type AssetVectors,
  type Concept,
  type ConceptEdge,
  type MediaAsset,
  type ScoredAsset,
} from "@/lib/catalog/types";
import type {
  CatalogIndexEntry,
  CatalogRepository,
  TextQuery,
  VectorQuery,
} from "./repository";
import type { ImageEmbeddingSpace } from "./providers";

const toVector = (values: number[]) => `[${values.join(",")}]`;

interface SearchRow {
  catalog_payload: MediaAsset;
  score: number;
  image_score: number | null;
}

export class PostgresCatalogRepository implements CatalogRepository {
  private readonly defaultImageSpace: ImageEmbeddingSpace;
  private titleSearchSupport?: Promise<boolean>;

  constructor(
    private readonly pool: Pool,
    imageModel = process.env.IMAGE_EMBEDDING_MODEL ?? "jinaai/jina-clip-v2",
    embeddingProvider = process.env.EMBEDDING_PROVIDER ?? "transformers",
  ) {
    this.defaultImageSpace =
      embeddingProvider === "jina-api"
        ? "jina-hosted"
        : /jina-clip-v2/i.test(imageModel)
          ? "jina-local"
          : /siglip/i.test(imageModel)
            ? "siglip"
            : "deterministic";
  }

  private imageColumn(space = this.defaultImageSpace) {
    if (space === "jina-hosted") return "jina_hosted_image_embedding";
    if (space === "jina-local") return "jina_image_embedding";
    if (space === "siglip") return "image_embedding";
    throw new Error(
      "The deterministic embedding space is not stored in PostgreSQL.",
    );
  }

  async supportsImageSpace(space: ImageEmbeddingSpace): Promise<boolean> {
    const targetColumn = this.imageColumn(space);
    const defaultColumn = this.imageColumn();
    const result = await this.pool.query<{
      default_count: string;
      missing_count: string;
    }>(
      `SELECT count(*) FILTER (WHERE ${defaultColumn} IS NOT NULL) AS default_count,
              count(*) FILTER (
                WHERE ${defaultColumn} IS NOT NULL
                  AND ${targetColumn} IS NULL
              ) AS missing_count
         FROM media_embeddings`,
    );
    const row = result.rows[0];
    return (
      Number(row?.default_count ?? 0) > 0 &&
      Number(row?.missing_count ?? 0) === 0
    );
  }

  supportsTitleSearch(): Promise<boolean> {
    if (!this.titleSearchSupport) {
      this.titleSearchSupport = this.pool
        .query<{ expected_count: string; missing_count: string }>(
          `SELECT count(*) FILTER (
                    WHERE embedding.jina_image_embedding IS NOT NULL
                      AND lower(trim(asset.title)) NOT IN ('', 'untitled')
                  ) AS expected_count,
                  count(*) FILTER (
                    WHERE embedding.jina_image_embedding IS NOT NULL
                      AND lower(trim(asset.title)) NOT IN ('', 'untitled')
                      AND embedding.jina_title_embedding IS NULL
                  ) AS missing_count
             FROM media_embeddings embedding
             JOIN media_assets asset ON asset.id = embedding.asset_id`,
        )
        .then(({ rows }) => {
          const row = rows[0];
          return (
            Number(row?.expected_count ?? 0) > 0 &&
            Number(row?.missing_count ?? 0) === 0
          );
        })
        .catch((error: unknown) => {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "42703"
          ) {
            return false;
          }
          throw error;
        });
    }
    return this.titleSearchSupport;
  }

  async prepare(): Promise<void> {
    const result = await this.pool.query<{ table_name: string | null }>(
      "SELECT to_regclass('public.media_embeddings')::text AS table_name",
    );
    if (!result.rows[0]?.table_name) {
      throw new Error(
        "PostgreSQL catalog is not initialized. Run Docker Compose so db/schema.sql is applied.",
      );
    }
  }

  async catalogAssets(channel: "artwork"): Promise<MediaAsset[]> {
    const imageColumn = this.imageColumn();
    const result = await this.pool.query<{ catalog_payload: MediaAsset }>(
      `SELECT asset.catalog_payload
         FROM media_assets asset
         JOIN media_embeddings embedding ON embedding.asset_id = asset.id
        WHERE asset.library_category = $1
          AND embedding.${imageColumn} IS NOT NULL`,
      [channel],
    );
    return result.rows.map((row) => row.catalog_payload);
  }

  async findAsset(id: string): Promise<MediaAsset | null> {
    const result = await this.pool.query<{ catalog_payload: MediaAsset }>(
      "SELECT catalog_payload FROM media_assets WHERE id = $1",
      [id],
    );
    return result.rows[0]?.catalog_payload ?? null;
  }

  async findAssetVectors(
    id: string,
    imageSpace = this.defaultImageSpace,
  ): Promise<AssetVectors | null> {
    const imageColumn = this.imageColumn(imageSpace);
    const embedding = await this.pool.query<{ image: string | null }>(
      `SELECT ${imageColumn}::text AS image
         FROM media_embeddings
        WHERE asset_id = $1`,
      [id],
    );
    const row = embedding.rows[0];
    if (!row?.image) return null;
    const image = this.parseVector(row.image);
    return {
      semantic: image,
      metadata: image,
      image,
    };
  }

  async search(query: VectorQuery): Promise<ScoredAsset[]> {
    const imageColumn = this.imageColumn(query.imageSpace);
    if (query.titleVector && imageColumn === "jina_image_embedding") {
      return this.searchHybrid(query);
    }
    const result = await this.pool.query<SearchRow>(
      `SELECT asset.catalog_payload,
              CASE WHEN $1::vector IS NULL OR embedding.${imageColumn} IS NULL
                       THEN 0
                       ELSE 1 - (embedding.${imageColumn} <=> $1::vector)
                  END AS image_score,
              CASE WHEN $1::vector IS NULL OR embedding.${imageColumn} IS NULL
                       THEN 0
                       ELSE (1 - (embedding.${imageColumn} <=> $1::vector)) * $2
                  END AS score
         FROM media_embeddings embedding
         JOIN media_assets asset ON asset.id = embedding.asset_id
        WHERE ($3::text IS NULL OR asset.id <> $3)
          AND asset.library_category = $5
          AND embedding.${imageColumn} IS NOT NULL
          AND ($6::text[] IS NULL OR asset.creator = ANY($6))
          AND ($7::text[] IS NULL OR asset.id = ANY($7))
          AND (($8::text[] IS NULL AND $9::text[] IS NULL)
            OR asset.catalog_payload->>'culture' = ANY($8)
            OR asset.catalog_payload->>'artistNationality' = ANY($9))
          AND ($10::integer IS NULL OR (
                (asset.catalog_payload->>'objectBeginDate')::integer <= $11
            AND (asset.catalog_payload->>'objectEndDate')::integer >= $10
            AND (asset.catalog_payload->>'objectEndDate')::integer
                - (asset.catalog_payload->>'objectBeginDate')::integer <= 100
          ))
          AND ($12::text[] IS NULL OR EXISTS (
                SELECT 1
                  FROM unnest($12::text[]) AS term
                 WHERE lower(asset.catalog_payload->>'medium')
                       LIKE '%' || term || '%'
          ))
        ORDER BY score DESC, asset.id
        LIMIT $4`,
      [
        query.imageVector ? toVector(query.imageVector) : null,
        query.weights.image ?? 0,
        query.excludeAssetId ?? null,
        query.limit,
        query.channel,
        query.creatorNames?.length ? query.creatorNames : null,
        query.assetIds?.length ? query.assetIds : null,
        query.cultures?.length ? query.cultures : null,
        query.artistNationalities?.length
          ? query.artistNationalities
          : null,
        query.yearRange?.start ?? null,
        query.yearRange?.end ?? null,
        query.mediumTerms?.length ? query.mediumTerms : null,
      ],
    );
    return result.rows.map((row) => ({
      asset: row.catalog_payload,
      score: Number(row.score),
      scores: {
        semantic: 0,
        metadata: 0,
        ...(row.image_score !== null ? { image: Number(row.image_score) } : {}),
      },
    }));
  }

  private async searchHybrid(query: VectorQuery): Promise<ScoredAsset[]> {
    const result = await this.pool.query<SearchRow>(
      `WITH filtered AS MATERIALIZED (
         SELECT asset.id,
                asset.catalog_payload,
                embedding.jina_image_embedding,
                embedding.jina_title_embedding
           FROM media_embeddings embedding
           JOIN media_assets asset ON asset.id = embedding.asset_id
          WHERE ($3::text IS NULL OR asset.id <> $3)
            AND asset.library_category = $5
            AND embedding.jina_image_embedding IS NOT NULL
            AND ($6::text[] IS NULL OR asset.creator = ANY($6))
            AND ($7::text[] IS NULL OR asset.id = ANY($7))
            AND (($8::text[] IS NULL AND $9::text[] IS NULL)
              OR asset.catalog_payload->>'culture' = ANY($8)
              OR asset.catalog_payload->>'artistNationality' = ANY($9))
            AND ($10::integer IS NULL OR (
                  (asset.catalog_payload->>'objectBeginDate')::integer <= $11
              AND (asset.catalog_payload->>'objectEndDate')::integer >= $10
              AND (asset.catalog_payload->>'objectEndDate')::integer
                  - (asset.catalog_payload->>'objectBeginDate')::integer <= 100
            ))
            AND ($12::text[] IS NULL OR EXISTS (
                  SELECT 1
                    FROM unnest($12::text[]) AS term
                   WHERE lower(asset.catalog_payload->>'medium')
                         LIKE '%' || term || '%'
            ))
       ),
       image_ranked AS (
         SELECT id,
                row_number() OVER (
                  ORDER BY jina_image_embedding <=> $1::vector, id
                ) AS rank,
                1 - (jina_image_embedding <=> $1::vector) AS image_score
           FROM filtered
          ORDER BY jina_image_embedding <=> $1::vector, id
          LIMIT $14
       ),
       title_ranked AS (
         SELECT id,
                row_number() OVER (
                  ORDER BY jina_title_embedding <=> $2::vector, id
                ) AS rank
           FROM filtered
          WHERE jina_title_embedding IS NOT NULL
          ORDER BY jina_title_embedding <=> $2::vector, id
          LIMIT $14
       ),
       fused AS (
         SELECT COALESCE(image_ranked.id, title_ranked.id) AS id,
                COALESCE(1.0 / ($13 + image_ranked.rank), 0)
                  + COALESCE(1.0 / ($13 + title_ranked.rank), 0) AS score,
                image_ranked.image_score
           FROM image_ranked
           FULL OUTER JOIN title_ranked USING (id)
       )
       SELECT filtered.catalog_payload,
              fused.score,
              fused.image_score
         FROM fused
         JOIN filtered USING (id)
        ORDER BY fused.score DESC, fused.id
        LIMIT $4`,
      [
        query.imageVector ? toVector(query.imageVector) : null,
        toVector(query.titleVector ?? []),
        query.excludeAssetId ?? null,
        query.limit,
        query.channel,
        query.creatorNames?.length ? query.creatorNames : null,
        query.assetIds?.length ? query.assetIds : null,
        query.cultures?.length ? query.cultures : null,
        query.artistNationalities?.length
          ? query.artistNationalities
          : null,
        query.yearRange?.start ?? null,
        query.yearRange?.end ?? null,
        query.mediumTerms?.length ? query.mediumTerms : null,
        query.rrfK ?? 20,
        Math.max(100, query.limit * 5),
      ],
    );
    return result.rows.map((row) => ({
      asset: row.catalog_payload,
      score: Number(row.score),
      scores: {
        semantic: 0,
        metadata: 0,
        ...(row.image_score !== null ? { image: Number(row.image_score) } : {}),
      },
    }));
  }

  async textSearch(query: TextQuery): Promise<ScoredAsset[]> {
    if (!query.text.trim()) return [];
    const imageColumn = this.imageColumn();
    const result = await this.pool.query<{
      catalog_payload: MediaAsset;
      score: number;
    }>(
      `WITH searchable AS (
         SELECT asset.*,
                setweight(to_tsvector('simple', COALESCE(asset.title, '')), 'A')
             || setweight(to_tsvector('simple', COALESCE(asset.creator, '')), 'A')
             || setweight(to_tsvector('simple', COALESCE(asset.year_display, '')), 'B')
             || setweight(to_tsvector('simple', COALESCE(asset.catalog_payload->>'culture', '')), 'B')
             || setweight(to_tsvector('simple', COALESCE(asset.catalog_payload->>'medium', '')), 'B')
             || setweight(to_tsvector('simple', COALESCE(asset.catalog_payload #>> '{semantics,associations}', '')), 'B')
                   AS document
           FROM media_assets asset
           JOIN media_embeddings embedding ON embedding.asset_id = asset.id
          WHERE asset.library_category = $2
            AND embedding.${imageColumn} IS NOT NULL
            AND ($4::text[] IS NULL OR asset.creator = ANY($4))
            AND ($5::text[] IS NULL OR asset.id = ANY($5))
            AND (($6::text[] IS NULL AND $7::text[] IS NULL)
              OR asset.catalog_payload->>'culture' = ANY($6)
              OR asset.catalog_payload->>'artistNationality' = ANY($7))
            AND ($8::integer IS NULL OR (
                  (asset.catalog_payload->>'objectBeginDate')::integer <= $9
              AND (asset.catalog_payload->>'objectEndDate')::integer >= $8
              AND (asset.catalog_payload->>'objectEndDate')::integer
                  - (asset.catalog_payload->>'objectBeginDate')::integer <= 100
            ))
            AND ($10::text[] IS NULL OR EXISTS (
                  SELECT 1
                    FROM unnest($10::text[]) AS term
                   WHERE lower(asset.catalog_payload->>'medium')
                         LIKE '%' || term || '%'
            ))
       ), parsed AS (
         SELECT websearch_to_tsquery('simple', $1) AS query
       )
       SELECT searchable.catalog_payload,
              ts_rank_cd(searchable.document, parsed.query, 32) AS score
         FROM searchable, parsed
        WHERE searchable.document @@ parsed.query
        ORDER BY score DESC, searchable.title
        LIMIT $3`,
      [
        query.text,
        query.channel,
        query.limit,
        query.creatorNames?.length ? query.creatorNames : null,
        query.assetIds?.length ? query.assetIds : null,
        query.cultures?.length ? query.cultures : null,
        query.artistNationalities?.length
          ? query.artistNationalities
          : null,
        query.yearRange?.start ?? null,
        query.yearRange?.end ?? null,
        query.mediumTerms?.length ? query.mediumTerms : null,
      ],
    );
    return result.rows.map((row) => ({
      asset: row.catalog_payload,
      score: Number(row.score),
      scores: { semantic: 0, metadata: Number(row.score) },
    }));
  }

  async concepts(): Promise<Concept[]> {
    const result = await this.pool.query<{
      id: string;
      label: string;
      description: string;
      aliases: string[];
    }>("SELECT id, label, description, aliases FROM concepts ORDER BY label");
    return result.rows;
  }

  async conceptEdges(): Promise<ConceptEdge[]> {
    const result = await this.pool.query<ConceptEdge>(
      `SELECT source_concept_id AS "from",
              target_concept_id AS "to",
              relation
         FROM concept_edges`,
    );
    return result.rows;
  }

  async upsertIndexedAsset(entry: CatalogIndexEntry): Promise<void> {
    await this.upsertIndexedAssets([entry]);
  }

  async upsertIndexedAssets(entries: CatalogIndexEntry[]): Promise<void> {
    if (!entries.length) return;
    const imageColumn = this.imageColumn();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const entry of entries) {
        const { asset, vectors, titleVector } = entry;
        await client.query(
        `INSERT INTO media_assets (
          id, media_type, library_category, title, creator, year_display, description, narrative,
           curator_notes, source_provider, source_url, media_url, license,
           license_url, owner_id, catalog_payload
         ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
         )
         ON CONFLICT (id) DO UPDATE SET
           media_type = EXCLUDED.media_type,
           library_category = EXCLUDED.library_category,
           title = EXCLUDED.title,
           creator = EXCLUDED.creator,
           year_display = EXCLUDED.year_display,
           description = EXCLUDED.description,
           narrative = EXCLUDED.narrative,
           curator_notes = EXCLUDED.curator_notes,
           source_provider = EXCLUDED.source_provider,
           source_url = EXCLUDED.source_url,
           media_url = EXCLUDED.media_url,
           license = EXCLUDED.license,
           license_url = EXCLUDED.license_url,
           owner_id = EXCLUDED.owner_id,
           catalog_payload = EXCLUDED.catalog_payload,
           updated_at = now()`,
        [
          asset.id,
          asset.type,
          asset.libraryCategory ?? "artwork",
          asset.title,
          asset.creator,
          asset.year,
          asset.semantics.description,
          asset.semantics.narrative,
          asset.semantics.curatorNotes ?? null,
          asset.source.provider,
          asset.source.sourceUrl,
          asset.source.mediaUrl ?? null,
          asset.source.license,
          asset.source.licenseUrl ?? null,
          asset.ownerId ?? null,
          asset,
        ],
        );
        await client.query("DELETE FROM asset_labels WHERE asset_id = $1", [
          asset.id,
        ]);
        const labels = [
          ...(asset.semantics.associations ?? []).map((label) => [
            "association",
            label,
          ]),
          ...asset.semantics.concepts.map((label) => ["concept", label]),
          ...asset.semantics.moods.map((label) => ["mood", label]),
          ...asset.semantics.subjects.map((label) => ["subject", label]),
        ];
        for (const [type, label] of labels) {
          await client.query(
            `INSERT INTO asset_labels (asset_id, label_type, label)
             VALUES ($1, $2, $3)`,
            [asset.id, type, label],
          );
        }
        await client.query(
        `INSERT INTO media_embeddings (
           asset_id, model_name, ${imageColumn}, jina_title_embedding
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (asset_id) DO UPDATE SET
           model_name = EXCLUDED.model_name,
           ${imageColumn} = COALESCE(
             EXCLUDED.${imageColumn},
             media_embeddings.${imageColumn}
           ),
           jina_title_embedding = COALESCE(
             EXCLUDED.jina_title_embedding,
             media_embeddings.jina_title_embedding
           ),
           embedded_at = now()`,
        [
          asset.id,
          entry.provider,
          vectors.image ? toVector(vectors.image) : null,
          titleVector ? toVector(titleVector) : null,
        ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async removeIndexedAsset(id: string): Promise<void> {
    await this.pool.query("DELETE FROM media_assets WHERE id = $1", [id]);
  }

  private parseVector(value: string) {
    return value
      .slice(1, -1)
      .split(",")
      .map((component) => Number(component));
  }
}
