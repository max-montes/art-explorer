import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalThumbnailStore } from "@/lib/curation/thumbnail-store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "art-explorer-thumbs-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const digest = "b".repeat(64);

const largeJpeg = () =>
  sharp({
    create: { width: 3000, height: 2000, channels: 3, background: "#884422" },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
    .then((buffer) => new Uint8Array(buffer));

describe("local thumbnail store", () => {
  it("bounds width, converts to webp, and reads the original only once", async () => {
    const store = new LocalThumbnailStore(root, 960);
    let reads = 0;
    const readOriginal = async () => {
      reads += 1;
      return largeJpeg();
    };

    const first = await store.get(digest, "image/jpeg", readOriginal);
    const second = await store.get(digest, "image/jpeg", readOriginal);

    expect(first?.mimeType).toBe("image/webp");
    const meta = await sharp(Buffer.from(first!.bytes)).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(960);
    expect(meta.height).toBe(640);
    expect(second?.bytes).toEqual(first?.bytes);
    expect(reads).toBe(1);
    expect(await readdir(root)).toEqual([`${digest}.webp`]);
  });

  it("does not upscale small images", async () => {
    const store = new LocalThumbnailStore(root, 960);
    const small = new Uint8Array(
      await sharp({
        create: { width: 300, height: 200, channels: 3, background: "#fff" },
      })
        .png()
        .toBuffer(),
    );
    const thumb = await store.get(digest, "image/png", async () => small);
    expect((await sharp(Buffer.from(thumb!.bytes)).metadata()).width).toBe(300);
  });

  it("returns null for media it cannot thumbnail and removes cached files", async () => {
    const store = new LocalThumbnailStore(root, 960);
    expect(await store.get(digest, "media/mp4", largeJpeg)).toBeNull();
    expect(await store.get(digest, "media/mpeg", largeJpeg)).toBeNull();

    await store.get(digest, "image/jpeg", largeJpeg);
    expect(await readdir(root)).toHaveLength(1);
    await store.remove(digest);
    await store.remove(digest); // idempotent
    expect(await readdir(root)).toHaveLength(0);
  });
});
