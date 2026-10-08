import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { prepareHostedJinaImage } from "../scripts/hosted-jina-image";

describe("hosted Jina image preprocessing", () => {
  it("resizes images inside the configured bounds and converts them to JPEG", async () => {
    const source = await sharp({
      create: {
        width: 1200,
        height: 600,
        channels: 3,
        background: "#c86432",
      },
    })
      .png()
      .toBuffer();

    const result = await prepareHostedJinaImage(
      `data:image/png;base64,${source.toString("base64")}`,
      512,
    );
    const output = Buffer.from(result.split(",")[1], "base64");
    const metadata = await sharp(output).metadata();

    expect(result).toMatch(/^data:image\/jpeg;base64,/);
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(256);
  });

  it("does not enlarge smaller images", async () => {
    const source = await sharp({
      create: {
        width: 320,
        height: 240,
        channels: 3,
        background: "#3264c8",
      },
    })
      .png()
      .toBuffer();

    const result = await prepareHostedJinaImage(
      `data:image/png;base64,${source.toString("base64")}`,
      512,
    );
    const metadata = await sharp(
      Buffer.from(result.split(",")[1], "base64"),
    ).metadata();

    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(240);
  });
});
