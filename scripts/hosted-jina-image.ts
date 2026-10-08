import sharp from "sharp";

export async function prepareHostedJinaImage(
  image: string,
  maxPixels: number,
): Promise<string> {
  if (!Number.isInteger(maxPixels) || maxPixels < 64) {
    throw new Error("JINA_IMAGE_MAX_PIXELS must be an integer of at least 64.");
  }
  const response = await fetch(image);
  if (!response.ok) {
    throw new Error(`Image download failed (${response.status}): ${image}`);
  }
  const source = Buffer.from(await response.arrayBuffer());
  const resized = await sharp(source)
    .rotate()
    .resize(maxPixels, maxPixels, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${resized.toString("base64")}`;
}
