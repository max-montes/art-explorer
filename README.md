# Art Explorer

**Search paintings in your own words.**

Describe a subject, mood, color, scene, or idea, and Art Explorer finds related
paintings from The Met's public-domain collection. You can also search by title
or artist.

## What it does

- Searches roughly 5,500 public-domain paintings from The Met.
- Understands visual and conceptual queries with SigLIP.
- Combines image similarity with titles, artists, dates, and associations.
- Suggests related ideas and visually similar paintings.
- Includes a small human-evaluation tool for tuning search quality.

## How it works

Art Explorer embeds each painting and each natural-language query with
`Xenova/siglip-base-patch16-224`. PostgreSQL and pgvector rank the resulting
768-dimensional image vectors, then blend that score with semantic associations
and metadata.

The catalog is paintings only. Sculptures, ceramics, vases, and decorative
objects are excluded.

## Run it

Requires Node.js 20+, Docker, and Docker Compose.

```bash
npm install
cp .env.example .env.local
docker compose up -d
CATALOG_REPOSITORY=postgres IMAGE_EMBEDDINGS=true npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Build the painting catalog

The bulk importer reads The Met's Open Access dataset from Hugging Face, caches
it locally, filters it to paintings, and prints progress as it runs.

```bash
npm run catalog:met:hf -- \
  --output curation/met-paintings.json \
  --limit 5516

IMAGE_EMBEDDINGS=true \
EMBEDDING_BATCH_SIZE=8 \
RESUME_SKIP_EXISTING=true \
npm run catalog:ingest -- curation/met-paintings.json
```

Ingestion is resumable. Broken image URLs are reported and skipped without
stopping the job.

## Evaluate search

Open [http://localhost:3000/eval.html](http://localhost:3000/eval.html) to label
the top results as relevant, unsure, or not relevant. Judgments are saved in the
browser and can be exported as JSON.

## Provenance

For this hackathon, I repurposed components and ideas from my own previous
projects, including **Art Guide** and **Semantic B-roll**. That foundation
includes semantic retrieval, vector indexing, curation and licensing workflows,
local media handling, drag-to-collect interaction, and script analysis.

Art Explorer adds a paintings-only Met catalog, SigLIP retrieval, resumable bulk
ingestion, and a human relevance-labeling workflow. All reused project work
referenced here is my own.

## Development

```bash
npm test
npm run typecheck
npm run lint
```
