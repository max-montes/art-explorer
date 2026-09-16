"use client";

import { DragEvent, ReactNode, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { filesFromDrop, hasFilePayload } from "@/lib/curation/dropped-files";
import {
  CURATOR_UPLOAD_EVENT,
  CURATOR_UPLOAD_STORAGE_KEY,
  uploadCuratorFiles,
} from "@/lib/curation/upload-client";
import styles from "./global-media-drop.module.css";

const SCHOOL_OF_ATHENS_URL =
  'https://upload.wikimedia.org/wikipedia/commons/4/49/%22The_School_of_Athens%22_by_Raffaello_Sanzio_da_Urbino.jpg';

export function GlobalMediaDrop({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    const overlayImage = new Image();
    overlayImage.src = SCHOOL_OF_ATHENS_URL;
    void overlayImage.decode().catch(() => undefined);
    return () => {
      overlayImage.src = "";
    };
  }, []);

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setUploading(true);
    try {
      const files = await filesFromDrop(event.dataTransfer);
      const result = await uploadCuratorFiles(files);
      sessionStorage.setItem(
        CURATOR_UPLOAD_STORAGE_KEY,
        JSON.stringify(result),
      );
      window.dispatchEvent(
        new CustomEvent(CURATOR_UPLOAD_EVENT, { detail: result }),
      );
      router.push("/admin/curation");
    } catch (error) {
      sessionStorage.setItem(
        CURATOR_UPLOAD_STORAGE_KEY,
        JSON.stringify({
          error: error instanceof Error ? error.message : "Upload failed.",
        }),
      );
      router.push("/admin/curation");
    } finally {
      setUploading(false);
      setDragActive(false);
    }
  };

  return (
    <div
      className={styles.dropSurface}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(event) => void onDrop(event)}
    >
      {children}
      {(dragActive || uploading) && (
        <div className={styles.dropOverlay} aria-live="polite">
          <div>
            <strong>{uploading ? "Adding media..." : "Drop media here"}</strong>
            <span>
              {uploading
                ? "Opening the artwork review queue"
                : "Artwork images and folders are supported"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
