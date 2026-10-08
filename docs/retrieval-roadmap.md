# Retrieval roadmap

Art Explorer now prioritizes deterministic catalog constraints followed by
direct Jina CLIP v2 image ranking. The following improvements observed in
[Semantic Art Search](https://github.com/KristianMSchmidt/semantic-art-search)
have been reproduced where they fit the current catalog.

## Implemented

- Local Jina text queries now use the model's official retrieval-query
  instruction instead of generic corpus-text embeddings. Hosted Jina sends the
  equivalent `task: retrieval.query` request.
- Named movements and style phrases automatically route to the retained
  SigLIP image index. General natural-language and image-similarity searches
  remain on Jina, and every API response identifies the model that served it.
- PostgreSQL search is exact at the current query shape: `EXPLAIN` confirms a
  sequential scan and full sort rather than an HNSW index scan. This matches
  Semantic Art Search's full-recall Qdrant setting and is inexpensive for
  3,125 paintings.
- The catalog is restricted to European Paintings, The American Wing, Robert
  Lehman Collection, and Modern and Contemporary Art. Existing SigLIP and
  local Jina vectors were preserved.
- Query-prompt experiments are reproducible with
  `npm run eval:query-prompts -- <label exports...>`.

## Deferred experiments

- Compare local Q4 Jina embeddings with Jina's hosted full-precision API on the
  same judged images.
- Compare the local 512-pixel processor with Jina API image tiling, which keeps
  more detail from larger source images.
- Add explicit work-type filters rather than treating every Met object in the
  Paintings classification as the same kind of work.
- Measure hubness correction or corpus-level similarity normalization for
  paintings that recur across unrelated abstract queries.
- Evaluate additional museums after the Met-only retrieval baseline is stable.

## Evidence to preserve

- On 12 blinded abstract queries, Jina-256 improved strict Precision@5 from
  36.7% to 46.7% and lenient Precision@5 from 41.7% to 55.0%.
- Jina won five queries, SigLIP won one, and six tied.
- Existing visual, artist-constrained visual, and image-similarity judgments
  showed no Jina regression, but had strong ceiling effects.
- Semantic Art Search performs exact cosine search over its selected image
  vector; it does not combine lexical, metadata, and image rankings.
- Its larger, multi-museum collection and pre-search filters can improve the
  candidate set independently of embedding-model quality.
- On the pruned catalog, the official local Jina retrieval instruction replaced
  41 of 60 abstract-query top-five candidates. Existing judgments cover too few of
  those new candidates for a defensible automatic win claim, so it should be
  evaluated as a new ranking rather than scored only against old labels.
