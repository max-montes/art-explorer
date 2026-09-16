import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const THUMBNAIL_WIDTH = 960;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Still-image types sharp can resize. */
const RESIZABLE = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/tiff",
]);

export interface Thumbnail {
  bytes: Uint8Array;
  mimeType: "image/webp";
}

/**
 * Digest-keyed, disk-cached thumbnails for local media. The first request for
 * a digest resizes the original once; every later request is a file read.
 * Lives beside the media store under ignored local app data.
 */
export class LocalThumbnailStore {
  constructor(
    private readonly directory =
      process.env.CURATION_THUMBNAIL_PATH ??
      path.join(process.cwd(), ".local-data", "thumbnails"),
    private readonly width = THUMBNAIL_WIDTH,
  ) {}

  static canThumbnail(mimeType: string) {
    return RESIZABLE.has(mimeType);
  }

  async get(
    sha256: string,
    mimeType: string,
    readOriginal: () => Promise<Uint8Array>,
  ): Promise<Thumbnail | null> {
    if (!LocalThumbnailStore.canThumbnail(mimeType)) return null;
    const filePath = this.resolve(sha256);
    try {
      const cached = await readFile(filePath);
      return { bytes: new Uint8Array(cached), mimeType: "image/webp" };
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
    const bytes = await this.render(await readOriginal());
    await mkdir(this.directory, { recursive: true });
    // Write-then-rename so a concurrent reader never sees a partial file.
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, filePath);
    return { bytes, mimeType: "image/webp" };
  }

  private async render(original: Uint8Array): Promise<Uint8Array> {
    const { default: sharp } = await import("sharp");
    return new Uint8Array(
      await sharp(original, { failOn: "none", limitInputPixels: false })
        .rotate()
        .resize({ width: this.width, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer(),
    );
  }

  private resolve(sha256: string) {
    if (!SHA256_PATTERN.test(sha256)) {
      throw new Error("Invalid media digest.");
    }
    return path.join(this.directory, `${sha256}.webp`);
  }

  async remove(sha256: string): Promise<void> {
    try {
      await unlink(this.resolve(sha256));
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
  }
}
