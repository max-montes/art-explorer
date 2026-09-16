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

## Retrieval design

Each artwork produces a semantic document from its associations and a metadata document from its title, creator, and year. Search emphasizes semantic similarity; similar-artwork search uses a small metadata component to recognize shared creator/title context. Follow-up pills come from strong matching associations.

Explore by idea splits text into passages, searches the artwork catalog for each passage, and exposes the associations behind the results.

## Development

```bash
npm test
npm run typecheck
npm run lint
```
