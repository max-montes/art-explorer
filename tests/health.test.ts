import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("pg", () => ({
  Pool: class {
    query = query;
  },
}));

import { GET } from "@/app/api/health/route";

describe("deployment health", () => {
  beforeEach(() => {
    vi.stubEnv("CATALOG_REPOSITORY", "postgres");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/art_explorer");
    query.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("is ready when the catalog has image vectors", async () => {
    query.mockResolvedValue({ rows: [{ assets: "17384", jina_images: "17380" }] });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      assets: 17384,
      jinaImages: 17380,
    });
  });

  it("is unready until the catalog is restored", async () => {
    query.mockResolvedValue({ rows: [{ assets: "0", jina_images: "0" }] });
    expect((await GET()).status).toBe(503);
  });

  it("requires image vectors, not just metadata", async () => {
    query.mockResolvedValue({ rows: [{ assets: "10", jina_images: "0" }] });
    expect((await GET()).status).toBe(503);
  });

  it("requires an explicit database connection", async () => {
    vi.stubEnv("DATABASE_URL", "");
    expect((await GET()).status).toBe(503);
    expect(query).not.toHaveBeenCalled();
  });

  it("logs connection errors without exposing them publicly", async () => {
    query.mockRejectedValue(new Error("private connection details"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "error",
      error: "Database unavailable.",
    });
    expect(log).toHaveBeenCalled();
  });

  it("does not query PostgreSQL in memory mode", async () => {
    vi.stubEnv("CATALOG_REPOSITORY", "memory");
    expect((await GET()).status).toBe(200);
    expect(query).not.toHaveBeenCalled();
  });
});
