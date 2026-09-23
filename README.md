# Art Explorer

**Search paintings in your own words.**

Describe a subject, mood, color, scene, or idea, and Art Explorer finds related
paintings from The Met's public-domain collection. You can also search by title
or artist.

## What it does

- Searches roughly 5,500 public-domain paintings from The Met.
- Uses Jina CLIP v2 for visual meaning and Met metadata for hard constraints.
- Keeps title, artist, date, culture, and medium in a separate metadata channel.
- Suggests related ideas and visually similar paintings.
- Includes a small human-evaluation tool for tuning search quality.

## How it works

Art Explorer embeds each painting and each residual natural-language query with
`jinaai/jina-clip-v2`, truncates the normalized vectors to 256 dimensions, and
uses PostgreSQL with pgvector for direct cosine ranking. Title, artist, date,
culture, nationality, and medium are resolved first as deterministic pins or
hard filters rather than blended into the image score.

The catalog is paintings only. Sculptures, ceramics, vases, and decorative
objects are excluded.

## Run it

Requires Node.js 20+, Docker, and Docker Compose.

```bash
npm install
cp .env.example .env.local
docker compose up -d
CATALOG_REPOSITORY=postgres npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Build the painting catalog

The bulk importer reads The Met's Open Access dataset from Hugging Face, caches
it locally, filters it to paintings, and prints progress as it runs.

```bash
npm run catalog:met:hf -- \
  --output curation/met-paintings.json \
  --limit 5516

IMAGE_EMBEDDING_MODEL=jinaai/jina-clip-v2 \
EMBEDDING_BATCH_SIZE=4 \
ONNX_INTRA_OP_THREADS=4 \
ONNX_INTER_OP_THREADS=1 \
RESUME_SKIP_EXISTING=true \
npm run catalog:ingest -- curation/met-paintings.json
```

Ingestion is resumable. Broken image URLs are reported and skipped without
stopping the job. Interactive inference defaults to one ONNX intra-op and
inter-op thread to avoid saturating the development server. Offline ingestion
can raise `ONNX_INTRA_OP_THREADS` based on the machine's available CPU.

To add Jina vectors to an existing catalog without rebuilding its metadata or
legacy SigLIP vectors:

```bash
IMAGE_EMBEDDING_MODEL=jinaai/jina-clip-v2 \
EMBEDDING_BATCH_SIZE=4 \
ONNX_INTRA_OP_THREADS=4 \
ONNX_INTER_OP_THREADS=1 \
npm run catalog:reindex:jina
```

The reindexer commits each batch, skips completed rows when restarted, and
reuses vectors from the local image-model evaluation cache when available.

## Evaluate search

Open [http://localhost:3000/eval.html](http://localhost:3000/eval.html) to label
direct Jina candidates as relevant, unsure, or not relevant. Judgments are
saved in the browser and can be exported as JSON.

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
