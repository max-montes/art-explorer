CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  CREATE TYPE media_type AS ENUM ('artwork');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;


DO $$ BEGIN
  CREATE TYPE label_type AS ENUM ('concept', 'mood', 'subject');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE label_type ADD VALUE IF NOT EXISTS 'association';

DO $$ BEGIN
  CREATE TYPE concept_relation AS ENUM (
    'related',
    'contrast',
    'cause',
    'consequence',
    'tension'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS concepts (
  id text PRIMARY KEY,
  label text NOT NULL,
  description text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS concept_edges (
  source_concept_id text NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  target_concept_id text NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  relation concept_relation NOT NULL,
  PRIMARY KEY (source_concept_id, target_concept_id, relation),
  CHECK (source_concept_id <> target_concept_id)
);

CREATE TABLE IF NOT EXISTS media_assets (
  id text PRIMARY KEY,
  media_type media_type NOT NULL,
  library_category text NOT NULL DEFAULT 'artwork'
    CHECK (library_category IN (
      'artwork'
    )),
  title text NOT NULL,
  creator text NOT NULL,
  year_display text NOT NULL,
  description text NOT NULL,
  narrative text NOT NULL,
  curator_notes text,
  source_provider text NOT NULL,
  source_url text NOT NULL,
  media_url text,
  license text NOT NULL,
  license_url text,
  owner_id uuid,
  catalog_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS library_category text NOT NULL DEFAULT 'artwork';

ALTER TABLE media_assets
  DROP CONSTRAINT IF EXISTS media_assets_library_category_check;
ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_library_category_check
  CHECK (library_category IN (
    'artwork'
  ));

CREATE TABLE IF NOT EXISTS asset_labels (
  asset_id text NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  label_type label_type NOT NULL,
  label text NOT NULL,
  PRIMARY KEY (asset_id, label_type, label)
);

CREATE INDEX IF NOT EXISTS asset_labels_lookup_idx
  ON asset_labels (label_type, label);

CREATE TABLE IF NOT EXISTS media_embeddings (
  asset_id text PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
  model_name text NOT NULL,
  document_version integer NOT NULL DEFAULT 1,
  semantic_document text NOT NULL,
  metadata_document text NOT NULL,
  semantic_embedding vector(384) NOT NULL,
  metadata_embedding vector(384) NOT NULL,
  image_embedding vector(512),
  embedded_at timestamptz NOT NULL DEFAULT now()
);

-- Pre-associations databases stored separate concept/mood vectors. Rebuild the
-- table on upgrade; approved curator records are rehydrated on boot.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'media_embeddings' AND column_name = 'concept_embedding'
  ) THEN
    DROP TABLE media_embeddings;
    CREATE TABLE media_embeddings (
      asset_id text PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
      model_name text NOT NULL,
      document_version integer NOT NULL DEFAULT 1,
      semantic_document text NOT NULL,
      metadata_document text NOT NULL,
      semantic_embedding vector(384) NOT NULL,
      metadata_embedding vector(384) NOT NULL,
      image_embedding vector(512),
      embedded_at timestamptz NOT NULL DEFAULT now()
    );
  END IF;
END $$;

ALTER TABLE media_embeddings
  ADD COLUMN IF NOT EXISTS image_embedding vector(512);

CREATE INDEX IF NOT EXISTS media_embeddings_semantic_hnsw_idx
  ON media_embeddings USING hnsw (semantic_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS media_embeddings_metadata_hnsw_idx
  ON media_embeddings USING hnsw (metadata_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS media_embeddings_image_hnsw_idx
  ON media_embeddings USING hnsw (image_embedding vector_cosine_ops);

-- One row per association so search can score by best-matching label rather
-- than a whole-list vector that dilutes literal matches.
CREATE TABLE IF NOT EXISTS asset_label_embeddings (
  asset_id text NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  position integer NOT NULL,
  label text NOT NULL,
  embedding vector(384) NOT NULL,
  PRIMARY KEY (asset_id, position)
);

CREATE INDEX IF NOT EXISTS asset_label_embeddings_hnsw_idx
  ON asset_label_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS curation_decisions (
  manifest_version integer NOT NULL,
  entry_id text PRIMARY KEY,
  source_path text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('include', 'exclude', 'review')),
  exclusion_reason text,
  review_reason text,
  metadata_status text NOT NULL
    CHECK (metadata_status IN ('complete', 'incomplete')),
  license_review_status text NOT NULL
    CHECK (license_review_status IN ('approved', 'pending', 'rejected')),
  asset_id text REFERENCES media_assets(id) ON DELETE SET NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (decision = 'exclude' AND exclusion_reason IS NOT NULL)
    OR (decision = 'include' AND exclusion_reason IS NULL)
    OR (decision = 'review' AND review_reason IS NOT NULL)
  )
);

ALTER TABLE curation_decisions
  DROP COLUMN IF EXISTS ai_generation_status;
