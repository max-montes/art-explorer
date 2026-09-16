import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { LocalCuratorIndexRepository } from "@/lib/curation/local-repository";
import { LocalMediaStore } from "@/lib/curation/local-media-store";
import { CuratorService } from "@/lib/curation/service";
import { NoopCuratorSuggestionProvider } from "@/lib/curation/suggestions";
import type { CuratorDraft } from "@/lib/curation/types";
import {
  normalizeAssociations,
  parseCuratorDraft,
  validateForApproval,
} from "@/lib/curation/validation";
import { hydrateCuratedCatalog } from "@/lib/retrieval/container";
import { MemoryCatalogRepository } from "@/lib/retrieval/memory-repository";
import { DeterministicEmbeddingProvider } from "@/lib/retrieval/providers";
import { RetrievalService } from "@/lib/retrieval/service";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "art-explorer-curation-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const semanticDraft = (
  draft: CuratorDraft,
  patch: Partial<CuratorDraft> = {},
): CuratorDraft => ({
  ...draft,
  title: "The Epistemic Lantern",
  creator: "",
  associations: ["epistemic lantern", "contemplative", "philosopher"],
  narrative: "A lantern illuminates the difficult pursuit of knowledge.",
  notes: "Manual labels are authoritative.",
  ...patch,
});

async function harness() {
  const provider = new DeterministicEmbeddingProvider();
  const catalog = new MemoryCatalogRepository(
    [],
    [],
    [],
    provider,
  );
  await catalog.prepare();
  const indexPath = path.join(root, "curation-index.json");
  const mediaPath = path.join(root, "media");
  const curatedPath = path.join(root, "curated");
  const index = new LocalCuratorIndexRepository(indexPath);
  const media = new LocalMediaStore(mediaPath, curatedPath);
  const curator = new CuratorService(
    index,
    catalog,
    media,
    provider,
    new NoopCuratorSuggestionProvider(),
  );
  return {
    catalog,
    curator,
    index,
    indexPath,
    media,
    mediaPath,
    curatedPath,
    provider,
    retrieval: new RetrievalService(catalog, provider),
  };
}

describe("curator catalog lifecycle", () => {
  it("records original pixel dimensions and backfills older records", async () => {
    const { curator, index, retrieval } = await harness();
    const png = new Uint8Array(
      await sharp({
        create: { width: 640, height: 400, channels: 3, background: "#333" },
      })
        .png()
        .toBuffer(),
    );
    const upload = await curator.upload("wide.png", "image/png", png);
    expect(upload.record.draft).toMatchObject({ width: 640, height: 400 });

    // Simulate a record created before dimensions existed.
    const legacyDraft = { ...upload.record.draft };
    delete legacyDraft.width;
    delete legacyDraft.height;
    await index.upsert({ ...upload.record, draft: legacyDraft });
    expect((await index.findById(legacyDraft.id))?.draft.width).toBeUndefined();
    const listed = await curator.list();
    expect(listed.find((r) => r.draft.id === legacyDraft.id)?.draft).toMatchObject(
      { width: 640, height: 400 },
    );
    expect((await index.findById(legacyDraft.id))?.draft.width).toBe(640);

    // Dimensions reach the catalog as a real aspect ratio for the grid.
    await curator.approve(semanticDraft(upload.record.draft));
    const asset = (await retrieval.search("epistemic lantern")).results[0].asset;
    expect(asset.width).toBe(640);
    expect(asset.aspectRatio).toBeCloseTo(1.6);


  });

  it("persists uploads, reloads the queue, and reuses duplicate blobs", async () => {
    const { curator, indexPath, mediaPath } = await harness();
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const first = await curator.upload("lantern.png", "image/png", bytes);
    const duplicate = await curator.upload("copy.png", "image/png", bytes);

    expect(first.record.draft.mediaType).toBe("artwork");
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.record.draft.id).toBe(first.record.draft.id);
    const reloaded = await new LocalCuratorIndexRepository(indexPath).list();
    expect(reloaded).toHaveLength(1);
    expect(
      new Uint8Array(
        await readFile(path.join(mediaPath, first.record.draft.sha256)),
      ),
    ).toEqual(bytes);
  });

  it.skip("infers artwork from media MIME types into the artwork catalog", async () => {
    const { curator } = await harness();
    const uploaded = await curator.upload(
      "meditation.mp3",
      "media/mpeg",
      new Uint8Array([73, 68, 51, 3]),
    );

    expect(uploaded.record.draft).toMatchObject({
      mediaType: "artwork",
      libraryCategory: "artwork",
    });
  });

  it("approves into public search and explore-similar", async () => {
    const { curator, curatedPath, retrieval } = await harness();
    const firstUpload = await curator.upload(
      "lantern.png",
      "image/png",
      new Uint8Array([1, 2, 3]),
    );
    const secondUpload = await curator.upload(
      "dialogue.png",
      "image/png",
      new Uint8Array([4, 5, 6]),
    );
    const first = await curator.approve(semanticDraft(firstUpload.record.draft));
    const second = await curator.approve(
      semanticDraft(secondUpload.record.draft, {
        title: "Dialogue by Lamplight",
        associations: ["epistemic lantern", "dialogue"],
      }),
    );

    expect((await retrieval.search("epistemic lantern")).results[0].asset.id).toBe(
      first.draft.id,
    );
    expect(
      (await retrieval.similar(first.draft.id)).results.map(
        (result) => result.asset.id,
      ),
    ).toContain(second.draft.id);
    expect(
      new Uint8Array(
        await readFile(path.join(curatedPath, "Artwork", "lantern.png")),
      ),
    ).toEqual(new Uint8Array([1, 2, 3]));
  });

  it.skip("defaults media to the artwork channel and keeps AI media unindexed", async () => {
    const { curator, curatedPath, retrieval } = await harness();
    const upload = await curator.upload(
      "dream-sequence.mp4",
      "media/mp4",
      new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
    );

    expect(upload.record.draft.mediaType).toBe("artwork");
    expect(upload.record.draft.libraryCategory).toBe("artwork");

    const approved = await curator.approve({
      ...upload.record.draft,
      libraryCategory: "artwork",
    });

    expect(
      new Uint8Array(
        await readFile(
          path.join(
            curatedPath,
            "AI Media",
            "Artwork",
            "dream-sequence.mp4",
          ),
        ),
      ),
    ).toEqual(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
    expect(approved.embedding.status).toBe("not-indexed");
    expect(
      (await retrieval.search("dream sequence", "artwork")).results.map(
        ({ asset }) => asset.id,
      ),
    ).not.toContain(approved.draft.id);
    expect(approved.draft.state).toBe("approved");
  });

  it.skip("publishes artwork into its own channel only", async () => {
    const { curator, curatedPath, retrieval } = await harness();
    const upload = await curator.upload(
      "prelinger-factory.jpg",
      "media/mp4",
      new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1]),
    );
    const approved = await curator.approve(
      semanticDraft(upload.record.draft, {
        libraryCategory: "artwork",
        associations: ["industrial history", "factory workers"],
        narrative: "Archival industrial footage from an earlier era.",
      }),
    );

    expect(
      new Uint8Array(
        await readFile(
          path.join(curatedPath, "Artwork", "prelinger-factory.jpg"),
        ),
      ),
    ).toEqual(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1]));
    const ids = (results: { asset: { id: string } }[]) =>
      results.map(({ asset }) => asset.id);
    expect(
      ids((await retrieval.search("industrial history", "artwork")).results),
    ).toContain(approved.draft.id);
    // Channels never mix: the same query on Artwork must not surface footage.
    expect(
      ids((await retrieval.search("industrial history", "artwork")).results),
    ).not.toContain(approved.draft.id);
  });

  it.skip("defaults GIFs to the artwork channel and upgrades legacy drafts", async () => {
    const { curator } = await harness();
    const upload = await curator.upload(
      "reaction.jpg",
      "image/jpeg",
      new Uint8Array([71, 73, 70, 56, 57, 97]),
    );
    expect(upload.record.draft).toMatchObject({
      mediaType: "artwork",
      libraryCategory: "artwork",
    });

    const legacy = { ...upload.record.draft, libraryCategory: undefined };
    expect(parseCuratorDraft(legacy).libraryCategory).toBe("artwork");
  });

  it.skip("removes an indexed item when it is reclassified as AI media", async () => {
    const { curator, retrieval } = await harness();
    const upload = await curator.upload(
      "lantern.png",
      "image/png",
      new Uint8Array([31, 32, 33]),
    );
    const indexed = await curator.approve(semanticDraft(upload.record.draft));
    expect(
      (await retrieval.search("epistemic lantern")).results.map(
        ({ asset }) => asset.id,
      ),
    ).toContain(indexed.draft.id);

    const aiMedia = await curator.approve({
      ...indexed.draft,
      libraryCategory: "artwork",
    });
    expect(aiMedia.embedding.status).toBe("not-indexed");
    expect(
      (await retrieval.search("epistemic lantern")).results.map(
        ({ asset }) => asset.id,
      ),
    ).not.toContain(indexed.draft.id);
  });

  it("removes stale edits until reapproval, then replaces retrieval metadata", async () => {
    const { curator, retrieval } = await harness();
    const upload = await curator.upload(
      "lantern.png",
      "image/png",
      new Uint8Array([7, 8, 9]),
    );
    const approved = await curator.approve(semanticDraft(upload.record.draft));
    const edited = semanticDraft(approved.draft, {
      title: "The Civic Mirror",
      associations: ["civic mirror"],
      narrative: "A city confronts its shared responsibility.",
    });
    const stale = await curator.saveDraft(edited);

    expect(stale.embedding.status).toBe("stale");
    expect(
      (await retrieval.search("epistemic lantern")).results.map(
        (result) => result.asset.id,
      ),
    ).not.toContain(approved.draft.id);

    const reapproved = await curator.approve(edited);
    expect(reapproved.embedding.version).toBe(2);
    const result = (await retrieval.search("civic mirror")).results[0].asset;
    expect(result.id).toBe(approved.draft.id);
    expect(result.title).toBe("The Civic Mirror");
  });

  it("deletes records, indexed assets, stored bytes, and published copies", async () => {
    const { curator, curatedPath, index, mediaPath, retrieval } = await harness();
    const upload = await curator.upload(
      "lantern.png",
      "image/png",
      new Uint8Array([41, 42, 43]),
    );
    const approved = await curator.approve(semanticDraft(upload.record.draft));

    expect(await curator.remove(approved.draft.id)).not.toBeNull();
    expect(await index.findById(approved.draft.id)).toBeNull();
    expect(
      (await retrieval.search("epistemic lantern")).results.map(
        ({ asset }) => asset.id,
      ),
    ).not.toContain(approved.draft.id);
    await expect(
      readFile(path.join(mediaPath, approved.draft.sha256)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(curatedPath, "Artwork", "lantern.png")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hydrates only approved indexed records after restart", async () => {
    const { curator, index, provider } = await harness();
    const approvedUpload = await curator.upload(
      "approved.png",
      "image/png",
      new Uint8Array([13, 14, 15]),
    );
    const draftUpload = await curator.upload(
      "draft.png",
      "image/png",
      new Uint8Array([16, 17, 18]),
    );
    const approved = await curator.approve(
      semanticDraft(approvedUpload.record.draft),
    );
    await curator.saveDraft(
      semanticDraft(draftUpload.record.draft, {
        associations: ["unpublished signal"],
      }),
    );

    const restarted = new MemoryCatalogRepository(
      [],
      [],
      [],
      provider,
    );
    await restarted.prepare();
    await hydrateCuratedCatalog(restarted, await index.list());
    const retrieval = new RetrievalService(restarted, provider);

    expect(
      (await retrieval.search("epistemic lantern")).results.map(
        (result) => result.asset.id,
      ),
    ).toContain(approved.draft.id);
    expect(
      (await retrieval.search("unpublished signal")).results.map(
        (result) => result.asset.id,
      ),
    ).not.toContain(draftUpload.record.draft.id);
  });

  it("re-embeds approved records on startup when the semantic document drifts", async () => {
    const { curator, index, provider } = await harness();
    const upload = await curator.upload(
      "vincent.png",
      "image/png",
      new Uint8Array([61, 62, 63]),
    );
    const approved = await curator.approve(
      semanticDraft(upload.record.draft, { creator: "François-André Vincent" }),
    );

    // Simulate a record embedded before the creator counted as an association.
    const staleDocuments = {
      semantic: "The Epistemic Lantern by François-André Vincent\nAssociations: Epistemic lantern",
      metadata: approved.embedding.documents!.metadata,
    };
    const [staleVector] = await provider.embed([staleDocuments.semantic]);
    await index.upsert({
      ...approved,
      embedding: {
        ...approved.embedding,
        documents: staleDocuments,
        vectors: { ...approved.embedding.vectors!, semantic: staleVector },
      },
    });

    const persisted: string[] = [];
    const restarted = new MemoryCatalogRepository([], [], [], provider);
    await restarted.prepare();
    await hydrateCuratedCatalog(restarted, await index.list(), {
      provider,
      persist: async (record) => {
        persisted.push(record.draft.id);
        await index.upsert(record);
      },
    });

    expect(persisted).toEqual([approved.draft.id]);
    const healed = await index.findById(approved.draft.id);
    expect(healed?.embedding.version).toBe(approved.embedding.version + 1);
    expect(healed?.embedding.documents?.semantic).toContain("François-André Vincent;");
    const retrieval = new RetrievalService(restarted, provider);
    expect(
      (await retrieval.search("François-André Vincent")).results[0].asset.id,
    ).toBe(approved.draft.id);

    // A second startup finds nothing to do.
    const again: string[] = [];
    await hydrateCuratedCatalog(restarted, await index.list(), {
      provider,
      persist: async (record) => {
        again.push(record.draft.id);
      },
    });
    expect(again).toEqual([]);
  });

  it("requires associations but not title, creator, narrative, or notes", async () => {
    const { curator } = await harness();
    const upload = await curator.upload(
      "untitled.png",
      "image/png",
      new Uint8Array([19, 20, 21]),
    );
    expect(validateForApproval(semanticDraft(upload.record.draft))).toEqual([]);
    expect(
      validateForApproval(
        semanticDraft(upload.record.draft, { narrative: "", notes: "" }),
      ),
    ).toEqual([]);
  });

  it("capitalizes associations and drops case-insensitive duplicates on save", () => {
    expect(
      normalizeAssociations([
        "divinity",
        " hercules ",
        "gods",
        "Gods",
        "youth   and wisdom",
        "",
        "Ascension",
        "Apotheosis.",
      ]),
    ).toEqual([
      "Divinity",
      "Hercules",
      "Gods",
      "Youth and wisdom",
      "Ascension",
      "Apotheosis",
    ]);
    // Variants are the curator's call; never merged silently.
    expect(normalizeAssociations(["Divine", "Divinity", "Humanism", "Humanity"]))
      .toEqual(["Divine", "Divinity", "Humanism", "Humanity"]);

    const parsed = parseCuratorDraft({
      ...semanticDraft({
        id: "curated-x",
        fileName: "x.png",
        sha256: "a".repeat(64),
        byteSize: 1,
        mimeType: "image/png",
        state: "draft",
        mediaType: "artwork",
        libraryCategory: "artwork",
        title: "",
        creator: "",
        associations: [],
        narrative: "",
        notes: "",
      }),
      associations: ["societal decay", "Societal Decay", "dread"],
    });
    expect(parsed.associations).toEqual(["Societal decay", "Dread"]);
  });

  it("carries identified provenance into the catalog while serving local media", async () => {
    const { curator, retrieval } = await harness();
    const upload = await curator.upload(
      "alcibiades.jpg",
      "image/jpeg",
      new Uint8Array([51, 52, 53]),
    );
    const approved = await curator.approve(
      semanticDraft(upload.record.draft, {
        title: "Alcibiade recevant les leçons de Socrate",
        creator: "François-André Vincent",
        year: "1776",
        source: {
          provider: "Wikimedia Commons",
          sourceUrl: "https://commons.wikimedia.org/wiki/File:Vincent.jpg",
          license: "Public domain",
        },
        associations: ["mentorship", "youth and wisdom"],
      }),
    );

    const asset = (await retrieval.search("mentorship")).results[0].asset;
    expect(asset.id).toBe(approved.draft.id);
    expect(asset.year).toBe("1776");
    expect(asset.source).toEqual({
      provider: "Wikimedia Commons",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Vincent.jpg",
      license: "Public domain",
      mediaUrl: `/api/local-media/${approved.draft.sha256}`,
    });
    expect(
      parseCuratorDraft(JSON.parse(JSON.stringify(approved.draft))).source,
    ).toEqual(approved.draft.source);
    expect(() =>
      parseCuratorDraft({
        ...approved.draft,
        source: { ...approved.draft.source, sourceUrl: "javascript:alert(1)" },
      }),
    ).toThrow(/https/);
  });
});
