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
- General Jina text searches fuse exact image and title-vector rankings with
  reciprocal rank fusion (`k=20`), matching Semantic Art Search's current
  default architecture. Exact-title similarity searches remain image-only,
  and SigLIP-routed style queries remain isolated from the Jina title space.
- Jina title vectors can be backfilled resumably with
  `npm run catalog:reindex:titles`. Automated weak-supervision checks are
  reproducible with `npm run eval:catalog-ground-truth`.
- Single-token artist aliases now scale with catalog evidence: prolific names
  such as `Homer`, `Monet`, and `Rembrandt` remain deterministic creator
  filters even when they appear in several unrelated titles, while common
  visual terms such as `church` remain embedding queries.
- PostgreSQL search is exact at the current query shape: `EXPLAIN` confirms a
  sequential scan and full sort rather than an HNSW index scan. This matches
  Semantic Art Search's full-recall Qdrant setting and is inexpensive for
  17,384 paintings.
- The Met catalog is restricted to European Paintings, The American Wing,
  Robert Lehman Collection, and Modern and Contemporary Art. Existing SigLIP
  and local Jina vectors were preserved.
- Equivalent painting-only, public-domain filters now include 1,252 works from
  the Art Institute of Chicago, 864 from the Cleveland Museum of Art, and
  4,614 from Statens Museum for Kunst, 2,914 from the National Gallery of Art,
  and 4,615 from the Rijksmuseum's Western paintings collection. The resulting
  17,384-work catalog covers European, American, and Modern painting
  departments with matched local Jina and SigLIP vector coverage for every
  work whose source image is still available.
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
- Evaluate further museums only when they add distinct open-access Western
  painting coverage.

## Evidence to preserve

- On 12 blinded abstract queries, Jina-256 improved strict Precision@5 from
  36.7% to 46.7% and lenient Precision@5 from 41.7% to 55.0%.
- Jina won five queries, SigLIP won one, and six tied.
- Existing visual, artist-constrained visual, and image-similarity judgments
  showed no Jina regression, but had strong ceiling effects.
- Semantic Art Search performs exact vector search and now fuses its Jina image
  and title rankings with reciprocal rank fusion in Auto mode.
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
- On the 17,384-work catalog, mean-similarity hubness correction reduced
  repeated top-five slots across 41 prior queries from 42 to 19 and increased
  unique results from 163 to 186. Only four corrected top-five results retained
  applicable old judgments, so the correction remains a blinded experiment
  rather than a production ranking change. Reproduce it with
  `HUBNESS_VARIANT=mean-0.75 npm run eval:hubness -- <label export>`.
- A 158-query metadata-grounded benchmark independently checks visual subjects,
  cross-museum creators, descriptions, and titles. Compared with Jina
  image-only search, Jina image/title RRF at `k=20` improved subject P@5 from
  7.8% to 15.6%, description P@5 from 5.0% to 13.3%, description hit@20 from
  38.3% to 81.7%, title nDCG@10 from 15.3% to 61.8%, and creator P@5 from 4.0%
  to 6.0%. These are noisy catalog-derived labels rather than human relevance
  judgments, but the gains are broad enough to support the production hybrid.
- On the existing 12-query human-labeled abstract pool, the same RRF setting
  improved strict P@5 from 40.6% to 43.9%, lenient P@5 from 57.2% to 60.6%,
  strict nDCG@5 from 82.4% to 83.3%, and lenient nDCG@5 from 84.7% to 91.7%.
  Reproduce the comparison with
  `npm run eval:hybrid-labels -- <label export>`.
