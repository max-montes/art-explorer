"use client";

import {
  ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  CuratorDraft,
  CuratorIndexRecord,
  EmbeddingState,
  ValidationIssue,
} from "@/lib/curation/types";
import { setFileDragData } from "@/lib/media/drag-export";
import {
  CURATOR_UPLOAD_EVENT,
  CURATOR_UPLOAD_STORAGE_KEY,
  uploadCuratorFiles,
} from "@/lib/curation/upload-client";
import type { CuratorUploadResult } from "@/lib/curation/upload-client";
import type { ArtworkIdentification } from "@/lib/curation/identify";
import { creatorNeedsReview } from "@/lib/curation/creator-name";
import { validateForApproval } from "@/lib/curation/validation";
import { mediaPreviewUrl } from "@/lib/media/preview-url";
import { FullscreenButton, Lightbox } from "./lightbox";
import styles from "./curator-workbench.module.css";

const categoryOptions: Array<{
  value: CuratorDraft["libraryCategory"];
  label: string;
}> = [
  { value: "artwork", label: "Artwork" },
];
const isImage = (draft: CuratorDraft) =>
  draft.mediaType === "artwork";

interface QueueItem {
  draft: CuratorDraft;
  /** Original bytes for download and fullscreen view. */
  mediaUrl: string;
  /** Bounded thumbnail for <img> display; never decodes a 15 MB original. */
  thumbUrl: string;
  embedding: EmbeddingState;
  duplicate: boolean;
  // Raw field text, so commas and spaces survive while typing.
  associationsText: string;
  dirty: boolean;
}

interface Feedback {
  tone: "success" | "error" | "info";
  message: string;
  issues?: ValidationIssue[];
}

const splitLabels = (value: string) =>
  [...new Set(value.split(",").map((label) => label.trim()).filter(Boolean))];

const fieldIssue = (issues: ValidationIssue[], field: ValidationIssue["field"]) =>
  issues.find((issue) => issue.field === field)?.message;

async function sendAction(
  action: "save" | "approve",
  draft: CuratorDraft,
) {
  const response = await fetch("/api/admin/curation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, draft }),
  });
  const payload: {
    record?: CuratorIndexRecord;
    error?: string;
    issues?: ValidationIssue[];
  } = await response.json();
  if (!response.ok || !payload.record) {
    const error = new Error(payload.error ?? "Curator action failed.");
    Object.assign(error, { issues: payload.issues });
    throw error;
  }
  return payload.record;
}

const toQueueItem = (
  record: CuratorIndexRecord,
  duplicate = false,
): QueueItem => ({
  draft: record.draft,
  mediaUrl: `/api/local-media/${record.draft.sha256}`,
  thumbUrl: mediaPreviewUrl(`/api/local-media/${record.draft.sha256}`),
  embedding: record.embedding,
  duplicate,
  associationsText: record.draft.associations.join(", "),
  dirty: false,
});

export function CuratorWorkbench() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [viewing, setViewing] = useState<QueueItem | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = queue.find((item) => item.draft.id === selectedId) ?? null;
  const approvalIssues =
    showValidation && selected ? validateForApproval(selected.draft) : [];

  const applyUploadResult = useCallback((result: CuratorUploadResult) => {
    const incoming = result.uploads.map(({ record, duplicate }) =>
      toQueueItem(record, duplicate),
    );
    setQueue((current) => {
      const byId = new Map(current.map((item) => [item.draft.id, item]));
      incoming.forEach((item) => byId.set(item.draft.id, item));
      return [...byId.values()];
    });
    setSelectedId(incoming[0]?.draft.id ?? null);
    setShowValidation(false);
    const duplicates = incoming.filter((item) => item.duplicate).length;
    setFeedback({
      tone: duplicates > 0 || result.skipped > 0 ? "info" : "success",
      message:
        result.skipped > 0
          ? `${incoming.length} media file${incoming.length === 1 ? "" : "s"} stored; ${result.skipped} unsupported file${result.skipped === 1 ? "" : "s"} skipped.`
          : duplicates > 0
            ? `${duplicates} duplicate file${duplicates === 1 ? "" : "s"} reused the existing SHA-256 record.`
            : `${incoming.length} file${incoming.length === 1 ? "" : "s"} stored locally.`,
    });
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/admin/curation")
      .then(async (response) => {
        const payload: { records?: CuratorIndexRecord[]; error?: string } =
          await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Queue load failed.");
        if (!active) return;
        // The queue is for review: drafts only, plus an approved record when
        // the curator arrived from the Collection's Edit action (?id=...).
        const requestedId = new URLSearchParams(window.location.search).get(
          "id",
        );
        const items = (payload.records ?? [])
          .filter(
            (record) =>
              record.draft.state !== "approved" ||
              record.draft.id === requestedId,
          )
          .map((record) => toQueueItem(record));
        setQueue(items);
        setSelectedId(
          items.find((item) => item.draft.id === requestedId)?.draft.id ??
            items[0]?.draft.id ??
            null,
        );
        const pending = sessionStorage.getItem(CURATOR_UPLOAD_STORAGE_KEY);
        if (pending) {
          sessionStorage.removeItem(CURATOR_UPLOAD_STORAGE_KEY);
          const handoff = JSON.parse(pending) as
            | CuratorUploadResult
            | { error: string };
          if ("error" in handoff) {
            setFeedback({ tone: "error", message: handoff.error });
          } else {
            applyUploadResult(handoff);
          }
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setFeedback({
            tone: "error",
            message:
              error instanceof Error ? error.message : "Queue load failed.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [applyUploadResult]);

  useEffect(() => {
    const receiveUpload = (event: Event) => {
      sessionStorage.removeItem(CURATOR_UPLOAD_STORAGE_KEY);
      applyUploadResult((event as CustomEvent<CuratorUploadResult>).detail);
    };
    window.addEventListener(CURATOR_UPLOAD_EVENT, receiveUpload);
    return () => window.removeEventListener(CURATOR_UPLOAD_EVENT, receiveUpload);
  }, [applyUploadResult]);

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    setFeedback({ tone: "info", message: "Hashing and storing local media..." });
    try {
      applyUploadResult(await uploadCuratorFiles(files));
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Upload failed.",
      });
    } finally {
      setBusy(false);
    }
  };

  const updateDraft = (patch: Partial<CuratorDraft>) => {
    if (!selectedId) return;
    setQueue((current) =>
      current.map((item) =>
        item.draft.id === selectedId
          ? { ...item, draft: { ...item.draft, ...patch }, dirty: true }
          : item,
      ),
    );
    setFeedback(null);
  };

  const applyAction = async (action: "save" | "approve") => {
    if (!selected) return;
    const editingApproved = selected.draft.state === "approved";
    setShowValidation(action === "approve");
    setBusy(true);
    setFeedback({
      tone: "info",
      message: editingApproved
        ? "Saving changes and refreshing the index..."
        : action === "approve"
          ? "Adding media to the collection..."
          : "Saving curation decision...",
    });
    try {
      const record = await sendAction(action, selected.draft);
      if (action === "approve" && !editingApproved) {
        // Approved items leave the review queue; move on to the next draft.
        const index = queue.findIndex((item) => item.draft.id === record.draft.id);
        const remaining = queue.filter((item) => item.draft.id !== record.draft.id);
        setQueue(remaining);
        setSelectedId(
          remaining[Math.min(index, remaining.length - 1)]?.draft.id ?? null,
        );
        setFeedback({
          tone: "success",
          message: `${record.draft.title || record.draft.fileName} approved and added to the collection.`,
        });
        setShowValidation(false);
        return;
      }
      setQueue((current) =>
        current.map((item) =>
          item.draft.id === record.draft.id
            ? {
                ...item,
                draft: record.draft,
                embedding: record.embedding,
                duplicate: false,
                dirty: false,
                associationsText: record.draft.associations.join(", "),
              }
            : item,
        ),
      );
      setFeedback({
        tone: "success",
        message: editingApproved
          ? "Changes saved. Search now reflects the updated details."
          : "Draft saved locally.",
      });
      setShowValidation(false);
    } catch (error) {
      const withIssues = error as Error & { issues?: ValidationIssue[] };
      setFeedback({
        tone: "error",
        message: withIssues.message,
        issues: withIssues.issues,
      });
    } finally {
      setBusy(false);
    }
  };

  const deleteItem = async (item: QueueItem) => {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/admin/curation?id=${encodeURIComponent(item.draft.id)}`,
        { method: "DELETE" },
      );
      const payload: { deletedId?: string; error?: string } =
        await response.json();
      if (!response.ok || !payload.deletedId) {
        throw new Error(payload.error ?? "Delete failed.");
      }
      const selectedIndex = queue.findIndex(
        (item) => item.draft.id === payload.deletedId,
      );
      const remaining = queue.filter(
        (item) => item.draft.id !== payload.deletedId,
      );
      setQueue(remaining);
      if (selectedId === payload.deletedId) {
        setSelectedId(
          remaining[Math.min(selectedIndex, remaining.length - 1)]?.draft.id ??
            null,
        );
      }
      setFeedback({
        tone: "success",
        message: `${item.draft.fileName} was deleted.`,
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Delete failed.",
      });
    } finally {
      setBusy(false);
    }
  };

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    void addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const identifyArtwork = async () => {
    if (!selected) return;
    setIdentifying(true);
    setBusy(true);
    setFeedback({ tone: "info", message: "Checking Wikimedia Commons..." });
    try {
      const response = await fetch("/api/admin/curation/identify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: selected.draft.id }),
      });
      const payload: {
        identification?: ArtworkIdentification | null;
        error?: string;
      } = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Lookup failed.");
      const match = payload.identification;
      if (!match) {
        setFeedback({
          tone: "info",
          message:
            "No exact match on Wikimedia Commons. This file was likely re-saved or cropped; enter the details manually.",
        });
        return;
      }
      // Fill only what the curator has not already typed.
      const patch: Partial<CuratorDraft> = {
        source: {
          provider: match.provider,
          sourceUrl: match.sourceUrl,
          license: match.license,
          ...(match.licenseUrl ? { licenseUrl: match.licenseUrl } : {}),
        },
      };
      if (!selected.draft.title && match.title) patch.title = match.title;
      if (!selected.draft.creator && match.creator) {
        patch.creator = match.creator;
      }
      if (!selected.draft.year && match.year) patch.year = match.year;
      updateDraft(patch);
      const kept = [
        selected.draft.title && match.title ? "title" : null,
        selected.draft.creator && match.creator ? "creator" : null,
        selected.draft.year && match.year ? "year" : null,
      ].filter(Boolean);
      const creatorNote =
        match.creatorSource === "wikidata"
          ? " Creator is the canonical Wikidata name."
          : match.creatorSource === "credit"
            ? creatorNeedsReview(match.creator)
              ? " Creator came from the upload credit and looks like it needs checking."
              : " Creator came from the upload credit; no Wikidata link on this file."
            : "";
      setFeedback({
        tone:
          match.creatorSource === "credit" && creatorNeedsReview(match.creator)
            ? "info"
            : "success",
        message: `Matched ${match.title}${match.creator ? ` by ${match.creator}` : ""}${match.year ? ` (${match.year})` : ""} · ${match.license}.${kept.length ? ` Your existing ${kept.join(" and ")} ${kept.length === 1 ? "was" : "were"} kept.` : ""}${creatorNote}`,
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Lookup failed.",
      });
    } finally {
      setIdentifying(false);
      setBusy(false);
    }
  };

  return (
    <main className={styles.shell}>
      <header className={styles.intro}>
        <div>
          <p>Art Explorer / contribute</p>
          <h1>Add artwork</h1>
        </div>
      </header>

      <div className={styles.workspace}>
        <aside className={styles.queuePanel}>
          <div
            className={styles.dropzone}
          >
            <strong>Drop artwork here</strong>
            <span>Still images — one or many</span>
            <button type="button" onClick={() => inputRef.current?.click()}>
              Choose files
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={onInput}
              hidden
            />
          </div>

          <div className={styles.queueHeading}>
            <h2>Review queue</h2>
            <span>{queue.length}</span>
          </div>
          <div className={styles.queue}>
            {queue.length === 0 && (
              <p className={styles.emptyQueue}>
                Nothing to review. Drop media to start, or open an approved
                item from the Collection to edit it.
              </p>
            )}
            {queue.map((item) => (
              <div className={styles.queueItemWrap} key={item.draft.id}>
                <button
                  type="button"
                  draggable
                  onDragStart={(event) =>
                    setFileDragData(event, {
                      url: item.mediaUrl,
                      mimeType: item.draft.mimeType,
                      fileName: item.draft.fileName,
                    })
                  }
                  className={`${styles.queueItem} ${
                    selectedId === item.draft.id ? styles.selected : ""
                  }`}
                  onClick={() => {
                    setSelectedId(item.draft.id);
                    setFeedback(null);
                    setShowValidation(false);
                  }}
                >
                  {isImage(item.draft) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.thumbUrl} alt="" loading="lazy" />
                  ) : (
                    <span>Artwork preview unavailable</span>
                  )}
                  <span>
                    <strong>{item.draft.title || item.draft.fileName}</strong>
                    <small>{item.draft.state}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.queueDelete}
                  aria-label={`Delete ${item.draft.title || item.draft.fileName}`}
                  title="Delete"
                  onClick={() => void deleteItem(item)}
                  disabled={busy}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </aside>

        <section className={styles.editor}>
          {!selected ? (
            <div className={styles.noSelection}>
              <span>01</span>
              <h2>Select media to begin curation.</h2>
              <p>
                Nothing is imported or approved merely because it was selected.
              </p>
            </div>
          ) : (
            <>
              <div className={styles.editorTop}>
                <div className={styles.preview}>
                  {isImage(selected.draft) ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={selected.thumbUrl}
                        alt={selected.draft.title || selected.draft.fileName}
                        draggable
                        onDragStart={(event) =>
                          setFileDragData(event, {
                            url: selected.mediaUrl,
                            mimeType: selected.draft.mimeType,
                            fileName: selected.draft.fileName,
                          })
                        }
                      />
                      <FullscreenButton
                        className={styles.previewFullscreen}
                        onClick={() => setViewing(selected)}
                      />
                      {selected.draft.width && selected.draft.height && (
                        <span className={styles.resolution}>
                          {selected.draft.width} × {selected.draft.height}
                        </span>
                      )}
                    </>
                  ) : (
                    <div>Artwork preview unavailable</div>
                  )}
                </div>
                <div className={styles.fileFacts}>
                  <span className={styles.state} data-state={selected.draft.state}>
                    {selected.draft.state}
                  </span>
                  <h2>{selected.draft.title || selected.draft.fileName}</h2>
                  <dl>
                    <div>
                      <dt>Media type</dt>
                      <dd>{selected.draft.mediaType}</dd>
                    </div>
                  </dl>
                  {selected.duplicate && (
                    <p className={styles.duplicate}>
                      This file is already in the review queue. You are editing
                      its existing details.
                    </p>
                  )}
                </div>
              </div>

              <div className={styles.formGrid}>
                <label>
                  Collection
                  <select
                    value={selected.draft.libraryCategory}
                    onChange={(event) =>
                      updateDraft({
                        libraryCategory: event.target
                          .value as CuratorDraft["libraryCategory"],
                      })
                    }
                  >
                    {categoryOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className={styles.identityRow}>
                  <label>
                    Title <em>optional</em>
                    <input
                      value={selected.draft.title}
                      onChange={(event) =>
                        updateDraft({ title: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Creator <em>optional</em>
                    <input
                      value={selected.draft.creator}
                      onChange={(event) =>
                        updateDraft({ creator: event.target.value })
                      }
                    />
                    {creatorNeedsReview(selected.draft.creator) && (
                      <small className={styles.hint}>
                        Looks abbreviated or like an upload credit — use the
                        artist&apos;s full name so one spelling is shared
                        across the catalog.
                      </small>
                    )}
                  </label>
                  <label className={styles.yearField}>
                    Year <em>optional</em>
                    <input
                      value={selected.draft.year ?? ""}
                      placeholder="1836 or c. 1510"
                      onChange={(event) =>
                        updateDraft({ year: event.target.value || undefined })
                      }
                    />
                  </label>
                  {isImage(selected.draft) && (
                    <button
                      type="button"
                      className={styles.identify}
                      onClick={() => void identifyArtwork()}
                      disabled={busy}
                      title="Look up title, creator, year, and license by exact file match on Wikimedia Commons"
                    >
                      {identifying ? "Looking up..." : "Identify"}
                    </button>
                  )}
                </div>
                {selected.draft.source && (
                  <p className={styles.provenance}>
                    <a
                      href={selected.draft.source.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {selected.draft.source.provider}
                    </a>
                    <span> · {selected.draft.source.license}</span>
                  </p>
                )}
                <label className={styles.associations}>
                  Associations
                  <input
                    value={selected.associationsText}
                    placeholder="Words or short phrases, separated by commas"
                    onChange={(event) => {
                      const text = event.target.value;
                      setQueue((current) =>
                        current.map((item) =>
                          item.draft.id === selected.draft.id
                            ? {
                                ...item,
                                associationsText: text,
                                dirty: true,
                                draft: {
                                  ...item.draft,
                                  associations: splitLabels(text),
                                },
                              }
                            : item,
                        ),
                      );
                      setFeedback(null);
                    }}
                    aria-invalid={Boolean(
                      fieldIssue(approvalIssues, "associations"),
                    )}
                  />
                  {fieldIssue(approvalIssues, "associations") ? (
                    <small>{fieldIssue(approvalIssues, "associations")}</small>
                  ) : (
                    <p className={styles.guidance}>
                      Write the words you would type to find this while
                      scripting. Name what it is <em>about</em>, not only what
                      is in it — the idea (<i>hubris</i>, <i>censorship</i>),
                      the feeling (<i>awe</i>, <i>dread</i>), then the subject
                      (<i>Socrates</i>, <i>skull</i>). Creator and century are
                      added for you.
                    </p>
                  )}
                </label>
              </div>

              {feedback && (
                <div className={styles.feedback} data-tone={feedback.tone}>
                  <strong>{feedback.message}</strong>
                  {feedback.issues && (
                    <ul>
                      {feedback.issues.map((issue) => (
                        <li key={`${issue.field}-${issue.message}`}>
                          {issue.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.delete}
                  onClick={() => void deleteItem(selected)}
                  disabled={busy}
                >
                  Delete
                </button>
                <div>
                  {selected.draft.state === "approved" ? (
                    <button
                      type="button"
                      className={styles.approve}
                      onClick={() => void applyAction("approve")}
                      disabled={busy || !selected.dirty}
                      title={
                        selected.dirty
                          ? "Save edits and refresh this item in search"
                          : "No unsaved changes"
                      }
                    >
                      {busy ? "Working..." : "Save changes"}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void applyAction("save")}
                        disabled={busy}
                      >
                        Save draft
                      </button>
                      <button
                        type="button"
                        className={styles.approve}
                        onClick={() => void applyAction("approve")}
                        disabled={busy}
                      >
                        {busy ? "Working..." : "Approve"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
      {viewing && (
        <Lightbox
          src={viewing.mediaUrl}
          alt={viewing.draft.title || viewing.draft.fileName}
          caption={[
            viewing.draft.title || viewing.draft.fileName,
            viewing.draft.creator,
            viewing.draft.year,
            viewing.draft.width && viewing.draft.height
              ? `${viewing.draft.width} × ${viewing.draft.height}`
              : undefined,
          ]
            .filter(Boolean)
            .join(" — ")}
          onClose={() => setViewing(null)}
        />
      )}
    </main>
  );
}
