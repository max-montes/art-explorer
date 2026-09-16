import type { DragEvent } from "react";
import type { MediaAsset } from "@/lib/catalog/types";

const extensionFor = () => ".jpg";

const safeFileName = (asset: MediaAsset) => {
  const stem = `${asset.creator}-${asset.title}`
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  const source = asset.source.mediaUrl ?? "";
  const sourceExtension = source.match(
    /\.(avif|jpe?g|png|webp)(?=$|\?)/i,
  )?.[0];
  return `${stem || asset.id}${sourceExtension ?? extensionFor()}`;
};

const mimeFor = (asset: MediaAsset) => {
  const source = asset.source.mediaUrl ?? "";
  if (/\.png(?:$|\?)/i.test(source)) return "image/png";
  if (/\.webp(?:$|\?)/i.test(source)) return "image/webp";
  if (/\.avif(?:$|\?)/i.test(source)) return "image/avif";
  return "image/jpeg";
};

export const mediaDragFile = (asset: MediaAsset) => {
  const url = asset.source.mediaUrl;
  if (!url) return null;
  return {
    url,
    mimeType: mimeFor(asset),
    fileName: safeFileName(asset),
  };
};

export function setFileDragData(
  event: DragEvent<HTMLElement>,
  file: { url: string; mimeType: string; fileName: string },
) {
  const absoluteUrl = new URL(file.url, window.location.origin).toString();
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("text/uri-list", absoluteUrl);
  event.dataTransfer.setData("text/plain", absoluteUrl);
  event.dataTransfer.setData(
    "DownloadURL",
    `${file.mimeType}:${file.fileName}:${absoluteUrl}`,
  );
}

export function setMediaDragData(
  event: DragEvent<HTMLElement>,
  asset: MediaAsset,
) {
  const file = mediaDragFile(asset);
  if (!file) {
    event.preventDefault();
    return;
  }
  setFileDragData(event, file);
}
