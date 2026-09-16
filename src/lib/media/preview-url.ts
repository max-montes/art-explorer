const WIKIMEDIA_IMAGE_PATH =
  /^\/wikipedia\/commons\/([^/]+)\/([^/]+)\/([^/]+\.(?:jpe?g|png|webp))$/i;
const LOCAL_MEDIA_PATH = /^\/api\/local-media\/([a-f0-9]{64})$/;

/**
 * Bounded preview for display surfaces. Originals stay untouched for drag,
 * download, and the fullscreen viewer; only the <img> on a card uses this.
 */
export function mediaPreviewUrl(mediaUrl: string, width = 960): string {
  const local = mediaUrl.match(LOCAL_MEDIA_PATH);
  if (local) return `/api/local-media/${local[1]}/thumb`;

  try {
    const url = new URL(mediaUrl);
    if (url.hostname !== "upload.wikimedia.org") return mediaUrl;

    const match = url.pathname.match(WIKIMEDIA_IMAGE_PATH);
    if (!match) return mediaUrl;

    const [, firstHash, secondHash, fileName] = match;
    return `${url.origin}/wikipedia/commons/thumb/${firstHash}/${secondHash}/${fileName}/${width}px-${fileName}`;
  } catch {
    return mediaUrl;
  }
}
