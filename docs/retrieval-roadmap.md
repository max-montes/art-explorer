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
- Equivalent painting-only, public-domain filters now include 1,252 works from
  the Art Institute of Chicago, 864 from the Cleveland Museum of Art, and
  4,614 from Statens Museum for Kunst. The resulting 9,855-work catalog covers
  European, American, and Modern painting departments with matched local Jina
  and SigLIP vector coverage for every work whose source image is still
  available.
- Query-prompt experiments are reproducible with
  `npm run eval:query-prompts -- <label exports...>`.
- Hosted Jina image ingestion now resizes source images locally, encodes them
  as JPEG quality 85, sends base64 rather than full-size Met URLs, respects the
  free account's observed 100k image-token/minute limit, and stops globally on
  quota exhaustion instead of retrying every remaining asset.
- Hosted/local comparisons are reproducible with
  `npm run eval:hosted-jina -- <label exports...>`. Results are cached after
  each batch so interrupted comparisons do not spend tokens twice.

## Deferred experiments

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
- Hosted full-precision Jina did not explain its advantage. On the 82 retained
  paintings with prior judgments, local Q4 scored 39.7% strict P@5, 55.2%
  lenient P@5, 69.6% strict nDCG@5, and 81.3% lenient nDCG@5. Hosted Jina at
  512px scored 41.4%, 56.9%, 65.1%, and 81.9%; at the benchmark's 800px size it
  scored 39.7%, 54.3%, 62.2%, and 79.0%. The small precision movement does not
  justify a paid full-catalog reindex, and larger inputs made ranking quality
  worse on this judged set.
- On the pruned catalog, the official local Jina retrieval instruction replaced
  41 of 60 abstract-query top-five candidates. Existing judgments cover too few of
  those new candidates for a defensible automatic win claim, so it should be
  evaluated as a new ranking rather than scored only against old labels.
