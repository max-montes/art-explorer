# Retrieval roadmap

Art Explorer now prioritizes deterministic catalog constraints followed by
direct Jina CLIP v2 image ranking. The following improvements observed in
[Semantic Art Search](https://github.com/KristianMSchmidt/semantic-art-search)
are intentionally deferred until the direct-ranking baseline is evaluated.

## Deferred experiments

- Compare local Q4 Jina embeddings with Jina's hosted full-precision API on the
  same judged images.
- Compare the local 512-pixel processor with Jina API image tiling, which keeps
  more detail from larger source images.
- Add explicit work-type filters rather than treating every Met object in the
  Paintings classification as the same kind of work.
- Test art-style routing: Jina for general natural-language queries and a
  dedicated CLIP model for named movements and styles.
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
