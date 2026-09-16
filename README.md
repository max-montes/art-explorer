# Art Explorer

Art Explorer is an artwork-only semantic catalog. Describe a mood, idea, subject, creator, or period to find curated works, explore similar artwork, and follow association-based suggestions.

## Features

- Artwork search and similar-artwork search powered by curator-authored associations.
- Explore by idea: paste writing or an idea list and inspect related artwork for each passage.
- Add artwork: review still images, edit metadata, and publish approved artwork.
- Drag artwork to an editor, inspect source/license metadata, and curate a persistent local catalog.
- PostgreSQL + pgvector storage or a zero-infrastructure in-memory repository.

The catalog contains explicitly reviewed still images. Animated and playable files are not part of the collection.

## Run the app

Requires Node.js 20+.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. The default Transformers.js embedding model runs locally and downloads on first search. For deterministic tests and a fast demo:

```bash
EMBEDDING_PROVIDER=deterministic npm run dev
```

### Image-aware retrieval

Transformers.js 4.2.0 includes an image-feature pipeline and CLIP model
projections. Set `IMAGE_EMBEDDINGS=true` to opt in to the compatible
`Xenova/clip-vit-base-patch32` path. During ingestion, absolute HTTP(S) image
URLs receive a 512-dimensional CLIP image vector in `media_embeddings`; text
queries also get a CLIP text vector. Hybrid search uses explicit normalized
weights: 0.90 CLIP text-to-image similarity, 0.05 existing association
similarity, and 0.05 metadata similarity. Together, the existing label and
metadata scores are the 10% text-side reranker. Metadata is a low-weight reranker,
not the primary meaning signal. The original text-only ranking remains intact
when the flag is unset or the CLIP model is unavailable. Relative local-media URLs
are intentionally skipped until a server-side file-input adapter is added.

PostgreSQL applies the nullable `image_embedding vector(512)` migration from
`db/schema.sql`; no FAISS index is required. HNSW can be added after the image
catalog is large enough to justify it.

## PostgreSQL + pgvector

```bash
docker compose up -d
CATALOG_REPOSITORY=postgres npm run dev
```

The schema stores artwork metadata, associations, canonical documents, and vectors in one transactional store. There is no seed step: approved curator records are loaded from the local curation index on boot.

## Curating artwork

Open `http://localhost:3000/admin/curation`. Drag still image files or folders into the app, review each candidate, and provide title, creator, provenance, license, and at least one association. Local image files are stored under ignored `.local-data/media/`; the artwork index stores review state and vectors. Source folders are never scanned implicitly.

Approved records are published under the `Artwork/` category and become searchable immediately. Draft records are not searchable. SHA-256 duplicate checks, safe local-media URLs, thumbnails, and deletion are handled by the curator service.

### Import a small Met Open Access slice

The first external catalog slice can be generated as a version-1 curation manifest. The importer only keeps public-domain Met records with an image and a conservative artwork department/classification match:

```bash
npm run catalog:met -- --output curation/met-open-access.json --limit 25
npm run catalog:ingest -- curation/met-open-access.json
```

`--limit` defaults to `25`. The importer uses polite delays between requests and exponential retries for transient API failures. The generated manifest contains CC0/public-domain source metadata and searchable associations derived from the Met department, classification, culture, and medium. Run it from a networked environment; the Met API is queried live and no API key is required.

The importer defaults to paintings and sculptures: it searches `painting` and
`sculpture` and requires a classification containing `painting(s)` or
`sculpture(s)`. Vases and explicitly decorative classifications are excluded
even when their department is an art department. Repeat `--query` only to
broaden candidate discovery; the painting/sculpture classification filter still
applies. IDs are deduplicated before `--limit` is applied:

```bash
npm run catalog:met -- --query painting --query sculpture \
  --output curation/met-open-access.json --limit 25
```

## Retrieval design

Each artwork produces a semantic document from its associations and a metadata document from its title, creator, and year. Search emphasizes semantic similarity; similar-artwork search uses a small metadata component to recognize shared creator/title context. Follow-up pills come from strong matching associations.

Explore by idea splits text into passages, searches the artwork catalog for each passage, and exposes the associations behind the results.

## Development

```bash
npm test
npm run typecheck
npm run lint
```
