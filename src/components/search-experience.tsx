"use client";

import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  assetAssociations,
  displayLabel,
  type MediaAsset,
  type ScoredAsset,
  type SearchResult,
} from "@/lib/catalog/types";
import { setMediaDragData } from "@/lib/media/drag-export";
import { mediaPreviewUrl } from "@/lib/media/preview-url";
import { FullscreenButton, Lightbox } from "./lightbox";
import { Masonry } from "./masonry";

const STARTING_QUERY = "Plato";
const UNDO_WINDOW_MS = 6000;

/**
 * Images per row. Stepping the count directly means every click visibly
 * changes the grid (a minimum-width scheme could need two clicks to drop a
 * column). Browser zoom still works independently because the masonry
 * converts the count to a width and caps it by what actually fits.
 */
const MIN_COLUMNS = 1;
const MAX_COLUMNS = 8;
const DEFAULT_COLUMNS = 3;
const COLUMNS_KEY = "commonplace:columns";
/** Narrowest a column may get before the masonry refuses to add more. */
const MIN_TILE_WIDTH = 160;

async function getJson(url: string): Promise<SearchResult> {
  const response = await fetch(url);
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : "Search failed.";
    throw new Error(message);
  }
  return payload as SearchResult;
}

function ResultCard({
  result,
  onSimilar,
  onDelete,
  onView,
}: {
  result: ScoredAsset;
  onSimilar: (asset: MediaAsset) => void;
  onDelete: (asset: MediaAsset) => void;
  onView: (asset: MediaAsset) => void;
}) {
  const { asset } = result;
  const mediaUrl = asset.source.mediaUrl;
  const previewUrl = mediaUrl ? mediaPreviewUrl(mediaUrl) : undefined;
  // Curator-approved items can be edited or removed from the collection.
  const curated = asset.id.startsWith("curated-");
  const activateSimilar = () => onSimilar(asset);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateSimilar();
    }
  };

  return (
    <article className="result-card">
      <div
        className="asset-visual"
        draggable={Boolean(mediaUrl)}
        onDragStart={(event) => setMediaDragData(event, asset)}
        style={{
          aspectRatio: asset.aspectRatio ?? 1.2,
          backgroundColor: asset.dominantColor ?? "#473d35",
        }}
        role="button"
        tabIndex={0}
        aria-label={`Explore assets similar to ${asset.title}`}
        onClick={activateSimilar}
        onKeyDown={handleKeyDown}
      >
        {mediaUrl ? (
          // A plain image preserves the browser context menu for curator downloads.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={`${asset.title} by ${asset.creator}`}
            decoding="async"
          />
        ) : (
          <div className="artwork-placeholder">Artwork preview unavailable</div>
        )}
        <div className="asset-actions">
          {mediaUrl &&
            asset.type === "artwork" && (
              <FullscreenButton onClick={() => onView(asset)} />
            )}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSimilar(asset);
            }}
          >
            Similar
          </button>
          {curated && (
            <>
              <a
                href={`/admin/curation?id=${encodeURIComponent(asset.id)}`}
                onClick={(event) => event.stopPropagation()}
                draggable={false}
              >
                Edit
              </a>
              <button
                type="button"
                className="danger"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(asset);
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
        <div className="similar-cue">Drag to collect · click for similar</div>
      </div>
      <div className="card-caption">
        <div>
          <h2>{asset.title}</h2>
          <p>
            {[asset.creator, asset.year !== "Unknown" ? asset.year : null]
              .filter(Boolean)
              .join(", ")}
            {asset.width && asset.height && (
              <span className="card-resolution">
                {asset.width} × {asset.height}
              </span>
            )}
          </p>
        </div>
        <a
          href={asset.source.sourceUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`View source and license for ${asset.title}`}
        >
          Source
        </a>
      </div>
      <div className="card-tags">
        {assetAssociations(asset)
          .slice(0, 3)
          .map((label) => (
            <span key={label}>{displayLabel(label)}</span>
          ))}
      </div>
    </article>
  );
}

function LoadingGrid() {
  return (
    <div className="results-grid results-grid-loading" aria-label="Loading semantic results">
      {Array.from({ length: 7 }, (_, index) => (
        <div
          className="result-skeleton"
          key={index}
          style={{ height: `${300 + ((index * 67) % 220)}px` }}
        />
      ))}
    </div>
  );
}

export function SearchExperience() {
  const [input, setInput] = useState(STARTING_QUERY);
  const [data, setData] = useState<SearchResult | null>(null);
  const dataRef = useRef<SearchResult | null>(null);
  dataRef.current = data;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<MediaAsset | null>(null);
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  // How many columns the grid can actually show at the current width/zoom.
  const [fits, setFits] = useState(MAX_COLUMNS);

  useEffect(() => {
    const raw = localStorage.getItem(COLUMNS_KEY);
    if (raw === null) return;
    const saved = Number(raw);
    if (Number.isInteger(saved) && saved >= MIN_COLUMNS && saved <= MAX_COLUMNS) {
      setColumns(saved);
    }
  }, []);

  const changeColumns = useCallback(
    (delta: number) => {
      setColumns((current) => {
        // Step from what is shown, not a stale larger request, so "−" after
        // hitting the width cap shrinks immediately.
        const shown = Math.min(current, fits);
        const next = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, shown + delta));
        localStorage.setItem(COLUMNS_KEY, String(next));
        return next;
      });
    },
    [fits],
  );

  /**
   * The URL is the source of truth for what is shown: /?q=… or
   * /?similar=<id>. Every search writes it (push for new searches, replace
   * and a single effect below reads it and fetches.
   * That makes results survive navigating away and back, the back button
   * step through searches, and any view shareable.
   */
  const navigate = useCallback(
    (params: Record<string, string | null>, mode: "push" | "replace") => {
      const url = new URL(window.location.href);
      for (const [key, value] of Object.entries(params)) {
        if (value === null) url.searchParams.delete(key);
        else url.searchParams.set(key, value);
      }
      if (url.href === window.location.href) return;
      if (mode === "push") window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    [],
  );

  const runSearch = useCallback(
    (query: string) => {
      const normalized = query.trim();
      if (!normalized) return;
      navigate({ q: normalized, similar: null }, "push");
    },
    [navigate],
  );

  const exploreSimilar = useCallback(
    (asset: MediaAsset) => {
      navigate({ similar: asset.id, q: null }, "push");
    },
    [navigate],
  );

  useEffect(() => {
    // Each load gets a ticket; only the newest may touch state, so a slow
    // response from a search you have already navigated away from is dropped.
    let latest = 0;
    const load = async () => {
      const ticket = ++latest;
      const params = new URLSearchParams(window.location.search);
      const similarId = params.get("similar");
      const query = params.get("q")?.trim() || STARTING_QUERY;

      setLoading(true);
      setError(null);
      try {
        if (similarId) {
          const result = await getJson(
            `/api/assets/${encodeURIComponent(similarId)}/similar`,
          );
          if (ticket !== latest) return;
          setInput(result.query);
          setData(result);
        } else {
          setInput(query);
          const result = await getJson(
            `/api/search?q=${encodeURIComponent(query)}`,
          );
          if (ticket !== latest) return;
          setData(result);
        }
      } catch (searchError) {
        if (ticket !== latest) return;
        setError(
          searchError instanceof Error
            ? searchError.message
            : "Semantic search failed.",
        );
      } finally {
        if (ticket === latest) setLoading(false);
      }
    };

    void load();
    const onPopState = () => void load();
    window.addEventListener("popstate", onPopState);
    return () => {
      latest++;
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  // Deletion is deferred: the card disappears immediately, the server call
  // happens only when the undo window closes. Undo therefore needs no
  // server-side restore of already-removed media.
  const pendingDelete = useRef<{
    result: ScoredAsset;
    index: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [toast, setToast] = useState<{ title: string } | null>(null);

  const commitDelete = useCallback(async (assetId: string, keepalive = false) => {
    try {
      const response = await fetch(
        `/api/admin/curation?id=${encodeURIComponent(assetId)}`,
        { method: "DELETE", keepalive },
      );
      const payload: { deletedId?: string; error?: string } =
        await response.json();
      if (!response.ok || !payload.deletedId) {
        throw new Error(payload.error ?? "Delete failed.");
      }
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "Delete failed.",
      );
    }
  }, []);

  const flushPendingDelete = useCallback(
    (keepalive = false) => {
      const pending = pendingDelete.current;
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingDelete.current = null;
      setToast(null);
      void commitDelete(pending.result.asset.id, keepalive);
    },
    [commitDelete],
  );

  const deleteAsset = useCallback(
    (asset: MediaAsset) => {
      // Only one undoable delete at a time; a second delete commits the first.
      flushPendingDelete();
      const current = dataRef.current;
      if (!current) return;
      const index = current.results.findIndex(
        (result) => result.asset.id === asset.id,
      );
      if (index === -1) return;
      const entry = { result: current.results[index], index };
      setData({
        ...current,
        results: current.results.filter((_, i) => i !== index),
      });
      const timer = setTimeout(() => {
        pendingDelete.current = null;
        setToast(null);
        void commitDelete(asset.id);
      }, UNDO_WINDOW_MS);
      pendingDelete.current = { ...entry, timer };
      setToast({ title: asset.title });
    },
    [commitDelete, flushPendingDelete],
  );

  const undoDelete = useCallback(() => {
    const pending = pendingDelete.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDelete.current = null;
    setToast(null);
    setData((current) => {
      if (!current) return current;
      const results = [...current.results];
      results.splice(Math.min(pending.index, results.length), 0, pending.result);
      return { ...current, results };
    });
  }, []);

  useEffect(() => {
    // Leaving the page should not silently cancel a delete the user confirmed
    // by letting the toast run; commit it with a keepalive request.
    const onPageHide = () => flushPendingDelete(true);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      flushPendingDelete(true);
    };
  }, [flushPendingDelete]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void runSearch(input);
  };

  return (
    <>
      <section className="hero">
        <form className="search-form" onSubmit={submit}>
          <label htmlFor="semantic-query">Search the curated catalog</label>
          <div className="search-row">
            <div className="search-control">
              <span aria-hidden="true">⌕</span>
              <input
                id="semantic-query"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Try 'societal decay' or 'awe'..."
                autoComplete="off"
              />
              <button type="submit" disabled={loading || !input.trim()}>
                {loading ? "Searching" : "Search"}
              </button>
            </div>
          </div>
        </form>
      </section>

      <section className="collection" aria-live="polite">
        {data && !loading && !error && (
          <div className="result-heading">
            <h2>{data.query}</h2>
            <div className="result-heading-tools">
              <div className="pills" aria-label="Related concepts">
                {data.pills.map((pill) => (
                  <button
                    key={pill.id}
                    type="button"
                    onClick={() => void runSearch(pill.label)}
                  >
                    {pill.label}
                  </button>
                ))}
              </div>
              <div className="tile-size" role="group" aria-label="Images per row">
                <button
                  type="button"
                  aria-label="Larger images (fewer per row)"
                  title="Larger images"
                  onClick={() => changeColumns(-1)}
                  disabled={columns <= MIN_COLUMNS}
                >
                  −
                </button>
                <button
                  type="button"
                  aria-label="Smaller images (more per row)"
                  title="Smaller images"
                  onClick={() => changeColumns(1)}
                  disabled={columns >= Math.min(MAX_COLUMNS, fits)}
                >
                  +
                </button>
              </div>
            </div>
          </div>
        )}

        {loading && <LoadingGrid />}

        {!loading && error && (
          <div className="state-panel error-panel">
            <span>Search interrupted</span>
            <h2>The catalog could not answer that query.</h2>
            <p>{error}</p>
            <button type="button" onClick={() => void runSearch(input)}>
              Try again
            </button>
          </div>
        )}

        {!loading && !error && data?.results.length === 0 && (
          <div className="state-panel">
            <span>No curated match</span>
            <h2>
              This idea is not in the collection yet.
            </h2>
            <p>
              Try a broader theme or add artwork through the Curator. The
              catalog intentionally does not guess beyond reviewed labels.
            </p>
          </div>
        )}

        {!loading && !error && data && data.results.length > 0 && (
          <Masonry
            className="results-grid"
            items={data.results}
            keyOf={(result) => result.asset.id}
            aspectRatioOf={(result) => result.asset.aspectRatio ?? 1.2}
            columns={columns}
            minColumnWidth={MIN_TILE_WIDTH}
            onFitsChange={setFits}
            render={(result) => (
              <ResultCard
                result={result}
                onSimilar={(asset) => void exploreSimilar(asset)}
                onDelete={deleteAsset}
                onView={setViewing}
              />
            )}
          />
        )}
      </section>

      {toast && (
        <div className="undo-toast" role="status">
          <span>
            Deleted <strong>{toast.title}</strong>
          </span>
          <button type="button" onClick={undoDelete}>
            Undo
          </button>
        </div>
      )}

      {viewing?.source.mediaUrl && (
        <Lightbox
          src={viewing.source.mediaUrl}
          alt={`${viewing.title} by ${viewing.creator}`}
          caption={[
            [viewing.title, viewing.creator, viewing.year !== "Unknown" ? viewing.year : null]
              .filter(Boolean)
              .join(" — "),
            viewing.width && viewing.height
              ? `${viewing.width} × ${viewing.height}`
              : null,
          ]
            .filter(Boolean)
            .join(" — ")}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}
